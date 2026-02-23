# Workflow Evaluation & Research Brief
**Date:** 2026-02-23  
**Context:** Evaluation of the agentic-dev-workflow package against state-of-the-art practices, with recommendations for improvement around long-running features and context management.

---

## Summary

The workflow is architecturally sound and aligns with what Anthropic's own engineering team publishes and what production practitioners report working well. The core design — lightweight orchestrator, fresh subagent per task, three-gate review — is correct.

The real strain is on **long-running features**: when context fills up and a new session must continue mid-feature, there is no durable state. The research points to two specific, fixable gaps that explain this.

---

## Research Sources

### Primary Sources

**[1] Anthropic Engineering — "Effective Harnesses for Long-Running Agents" (Nov 2025)**  
https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents

Anthropic's own team documenting what broke and what they fixed when building Claude agents that span multiple context windows. Two failure modes they identify:

> *"The agent tended to try to do too much at once — running out of context in the middle of implementation, leaving the next session to start with a feature half-implemented and undocumented."*

> *"After some features had been built, a later agent instance would look around, see that progress had been made, and declare the job done."*

Solution: a structured **`claude-progress.txt`** file + a **feature list JSON** (not Markdown — models are less likely to accidentally overwrite JSON) in the worktree root. Every session reads both files first. Git history provides the diff record. Boot sequence on every new session:
1. Read feature list → pick highest-priority incomplete feature
2. Read progress file + `git log --oneline -20` → get context on recent work
3. Run `pwd` → confirm working directory
4. Run baseline test → verify nothing broken before starting

---

**[2] Hugues Clouâtre — "Orchestrating AI Agents: A Subagent Architecture for Code" (Dec 2025)**  
https://clouatre.ca/posts/orchestrating-ai-agents-subagent-architecture

Production practitioner using Goose (similar architecture). Three key insights:

**Handoff files replace session-memory for state:**
Subagents write structured JSON to `.handoff/` in the worktree after each phase. Each subsequent agent reads its input file rather than receiving state via session context. Resumable from any interruption.

```
.handoff/
├── 02-plan.json       # Orchestrator → Builder
├── 03-build.json      # Builder → Validator
└── 04-validation.json # Validator → Builder (on failure)
```

**Architecture matters more than model choice:**
> *"Basic code assistants show roughly 10% productivity gains. But companies pairing AI with end-to-end process transformation report 25-30% improvements (Bain, 2025). The difference isn't the model. It's the architecture."*

Cites Anthropic research: "token usage explains 80% of the variance" — focused context rather than accumulated history.

**Model tiering by phase:**
| Model | Role | Rationale |
|---|---|---|
| Opus | Orchestrator/Planning | High reasoning for research and planning |
| Haiku | Building | Fast, cheap, precise instruction-following |
| Sonnet | Validation | Balanced judgment, conservative |

Building is the most token-heavy phase (~60% of tokens) — routing to Haiku cuts cost without quality loss.

---

**[3] paddo.dev — "Stop Speedrunning Claude Code" (updated Jan 2026)**  
https://paddo.dev/blog/stop-speedrunning-claude-code

Claude Code user but lessons transfer to any pi workflow:

> *"Context anxiety is real. As the context window fills up, Claude starts taking shortcuts. Responses get less thorough. It skips edge cases."*

On the core loop:
> *"The ones struggling share a pattern: skipping planning to save time, then spending more time fixing mistakes."*

Key practices:
- **Start every task with clean/compacted context** — not sometimes, every time
- **CLAUDE.md / AGENTS.md** — short, specific, opinionated; documents what went wrong so it doesn't happen again; global preferences in `~/.claude/CLAUDE.md`, project-specific in `./CLAUDE.md`
- **`/compact`** rather than `/clear` when the recent task is relevant to the next one
- **Plan mode for almost everything** — catches flawed approaches, missed edge cases, communication gaps while they're still just text

---

**[4] Tweag — "Agentic Coding Handbook" (2025)**  
https://tweag.github.io/agentic-coding-handbook

A controlled experiment comparing AI-assisted teams to traditional teams:
> *"AI-assisted teams delivered projects 45% faster, with high code quality and much less manual effort."*

Key finding: Success came from **spec-first + structured review discipline**, not raw model capability. Smaller tasks, clearer prompts, stronger review gates.

---

**[5] Anthropic — "Building Effective AI Agents"**  
https://resources.anthropic.com/building-effective-ai-agents

Anthropic's canonical guidance on multi-agent systems. Relevant to the reviewer/implementer pattern: the ordered gate structure (spec compliance → quality → security) maps to their recommended "validate at each stage" principle.

---

**[6] Additional Context**

- DeepWiki on sub-agents and context isolation: https://deepwiki.com/humanlayer/advanced-context-engineering-for-coding-agents/4.3-sub-agents-and-context-isolation
- arXiv production-grade agentic workflow paper: https://arxiv.org/abs/2512.08769
- Claude Code common workflows docs: https://code.claude.com/docs/en/common-workflows
- Anthropic context management blog: https://www.claude.com/blog/context-management

---

## What's Working (Keep These)

| Strength | Validation |
|---|---|
| Fresh subagent per task (context isolation) | Confirmed by Anthropic research and Clouâtre |
| Three-gate review (spec → quality → security) | Validated by Anthropic's multi-agent guidance |
| Plan-first, execute-second | Tweag found 45% faster delivery with this approach |
| Task text inline in subagent dispatch (not file paths) | Clouâtre's "minimalist instructions" principle |
| Worktree isolation | Correct — git history as state record is what Anthropic settled on |
| Model tiering (haiku for scouts, sonnet for reviewers) | Validated by Clouâtre's cost/quality analysis |

---

## The Two Gaps That Actually Matter

### Gap 1: No Persistent Progress State for Long-Running Features

**The problem:** When a session closes mid-feature, or context fills up and a fresh session resumes, there is no durable record of execution state. Which tasks are done? Which are at which review gate? What did the last implementer find? Reconstruction from `git log` is manual and lossy.

**What Anthropic does:** A `claude-progress.txt` in the worktree root. Every session reads it first. Every coding agent writes to it after completing its work. Alongside git history, this is the full state record.

**What Clouâtre does:** `.handoff/` directory with per-phase JSON files. Agents read their input file at startup instead of reconstructing state from session context.

**The fix:** A `PROGRESS.md` file in the worktree (e.g. `docs/plans/PROGRESS.md`), written by the implementer after each task commit. Simple format — task name, commit SHA, status, notes for subsequent tasks. The orchestrator reads this at session start to resume. The implementer prompt gets one line: *"After committing, append your task status to `docs/plans/PROGRESS.md`."*

---

### Gap 2: No Resume Protocol for the Orchestrator

**The problem:** When opening a new session to continue a feature, there is no structured boot sequence. The orchestrator has to manually reconstruct state — re-read the plan, check git log, determine what's pending. This costs time and risks missing something.

**What Anthropic does:** Every coding agent session starts with a fixed boot sequence before touching any implementation:
1. Read feature list → pick highest-priority incomplete item
2. Read progress file + git log → understand recent context  
3. Confirm working directory
4. Run baseline test → verify clean starting point

**The fix:** A "resume" section in the `subagent-driven-development` skill: when loading mid-feature, before dispatching any subagent, run the 4-step boot sequence. Then pick up at the first incomplete task in `PROGRESS.md`.

---

## Gaps That Are Real But Not Worth Fixing Now

| Gap | Why to skip |
|---|---|
| Dependency graph in plans | Plan author has full context; formalizing adds complexity without gain |
| Auto-trigger security for file patterns | You already know when auth/API files are touched — trust the orchestrator |
| "Quick feature" fast lane | You already make this judgment informally; documenting it just adds a decision point |
| Automated spec compliance checking | The spec-reviewer agent already does this better than a linter would |
| Multi-skill auto-chaining | Low friction — each skill tells you what to load next |
| Worktree cleanup on failure | `git worktree list` + manual cleanup is sufficient |

---

## The One Structural Change Worth Making

**The implementer should write to a progress file as part of its commit step.**

Right now the implementer commits and reports back to the orchestrator — but that report lives in session context, which is exactly what gets lost when you start a new session.

If the implementer writes its report to a file in the worktree instead, every completed task is durably recorded independent of session state.

**Implementer prompt addition:**
> *"After committing, append your task completion to `docs/plans/PROGRESS.md` in the worktree: task name, commit SHA, what was built, any notes for subsequent tasks."*

**Subagent-driven-development skill addition:**
> *"If `docs/plans/PROGRESS.md` exists in the worktree, read it first to determine which tasks are complete and where to resume."*

No new infrastructure. No new agents. Just durable state.

---

## Rename Recommendation

The current name `agentic-dev-workflow` is descriptive but generic and long. Recommendations for a pi package name:

| Name | Rationale |
|---|---|
| **`forge`** | Short, memorable, evokes deliberate crafting (not just generating). Install: `pi install git:josorio7122/forge` |
| `shipwright` | Ship + builder — captures full lifecycle |
| `conductor` | Orchestration theme — you conduct the agents |
| `meridian` | Navigation reference point — you always know where you are |

**Recommended: `forge`** — fits the "engineer not code writer" philosophy, npm-friendly length, not already a prominent pi package.
