# Agentic Dev Workflow

A state-of-the-art agentic development workflow for [pi](https://github.com/badlogic/pi). Multi-agent execution with parallel scouts, three-gate review per task, and full lifecycle from research to ship.

## Install

```bash
pi install /path/to/agentic-dev-workflow
```

Or from git once published:

```bash
pi install git:github.com/yourname/agentic-dev-workflow
```

## What's Included

- **14 skills** — full workflow from research through shipping
- **11 agents** — specialist subagents for every phase
- **3 extensions** — context budget indicator, workflow phase status bar, PR review widget
- **1 prompt template** — `/pr-review` for deep GitHub PR analysis

---

## How It All Fits Together

You have two entry points depending on whether you're starting something new or working on an existing codebase. Everything else is the same from brainstorming onward.

```
New project:      research → brainstorm → [spec] → plan → worktree → execute → review → ship
Existing project: understand → brainstorm → [spec] → plan → worktree → execute → review → ship
```

The main pi session is your **orchestrator**. It never implements anything directly — it designs, plans, and dispatches subagents to do the actual work. Each subagent runs in an isolated context window so it can't pollute your session's token budget.

---

## The Two Layers

**Skills** = instructions loaded into the main session. They guide *you* (the orchestrator) through a phase. Interactive, conversational, ask you questions.

**Agents** = subprocesses. Headless. Get a task string, do work, return output. Never interact with you directly.

Skills orchestrate agents. You orchestrate skills.

---

## Walking Through a Real Feature

### Starting on an existing codebase

You open pi and say: *"I want to add OAuth login to this app."*

**Step 1 — Understand the codebase**

Pi loads `understand-codebase`. It asks: *"What are you trying to do?"* You explain. Then it dispatches 4 scouts in parallel:

- Scout 1: What is this product? Who uses it?
- Scout 2: How is the code structured? What are the layers?
- Scout 3: What's the tech stack? (returns package.json too)
- Scout 4: Find everything related to auth, sessions, user management

While those run, you see them in the subagent panel — tool calls streaming live, each one working independently. When they finish, pi feeds the package.json from Scout 3 to a `researcher` agent that checks dependency health.

Pi synthesizes everything into a **Codebase Brief** — product summary, architecture map, tech stack, relevant files, dependency health. Presents it to you. *"Does this match your understanding?"* You confirm.

**Step 2 — Brainstorm**

Pi loads `brainstorming`. It's now in the main session with the full codebase brief as context. It asks you questions one at a time:

- *"Are you integrating with a specific OAuth provider, or multiple?"*
- *"Do you want social login (Google/GitHub) or enterprise SSO (SAML/OIDC)?"*
- *"Should existing password-based accounts be mergeable with OAuth?"*

After a few questions, it proposes 2-3 approaches with trade-offs and a recommendation. You pick one. It presents the design section by section, getting your approval on each. When you're happy, it saves a design doc to `docs/plans/YYYY-MM-DD-oauth-design.md` and commits it.

**Step 3 — Spec (optional)**

If this is complex with cross-cutting effects (auth touches sessions, user model, API middleware, frontend), pi loads `spec-writer`. It interviews you systematically — one question at a time — and produces a complete behavioral spec: data model changes, API contract, UI behavior, edge cases. This becomes the source of truth the `spec-reviewer` agent checks against later.

For simpler features, skip this — the design doc is enough.

**Step 4 — Plan**

Pi loads `writing-plans`. With the design doc and spec in context, it writes a detailed implementation plan to `docs/plans/YYYY-MM-DD-oauth-plan.md`. Not vague bullet points — actual code, exact file paths, TDD steps with expected test output, exact git commands. Something like:

```
Task 1: Add OAuth provider config
Files: Create src/auth/oauth.ts, modify src/config/index.ts

Step 1: Write failing test
  test('loads OAuth config from env', () => { ... })
  Run: npm test src/auth/oauth.test.ts
  Expected: FAIL — "Cannot find module"

Step 2: Implement
  export const oauthConfig = { ... }

Step 3: Run test
  Expected: PASS

Step 4: Commit
  git commit -m "feat: add OAuth provider config"
```

Every task is self-contained enough that a subagent with zero prior context can execute it blindly.

**Step 5 — Worktree**

Pi loads `using-git-worktrees`. It checks if `.worktrees/` exists, verifies it's gitignored, creates `.worktrees/feature/oauth-login`, runs `npm install`, runs the full test suite to confirm a clean baseline. Reports: *"47 tests passing. Ready."*

**Step 6 — Execute**

Pi loads `subagent-driven-development`. This is where the real work happens.

For each task in the plan, pi dispatches a fresh `implementer` subagent with the full task text (not a file path — the actual content). The implementer:
- Writes the failing test
- Watches it fail
- Writes minimal code to pass
- Commits
- Self-reviews
- Reports back

Then pi immediately dispatches a `spec-reviewer` with the task requirements and the implementer's commit SHA. The spec-reviewer reads the actual code (doesn't trust the implementer's report) and either:
- ✅ passes → pi dispatches `code-quality-reviewer`
- ❌ fails → pi dispatches implementer again with the specific issue list, then re-runs spec-reviewer

After quality review passes, pi dispatches `security-reviewer` on the diff. Security issues found here are cheap to fix. Security issues found in production are not.

When all three gates pass, the task is marked complete. Pi moves to the next task. You watch it all happen in the subagent panel — each agent's tool calls, what it read, what it found.

When all tasks complete, pi dispatches the `reviewer` agent for a final holistic pass over the entire branch diff — checking consistency across tasks, integration quality, anything the per-task reviewers might have missed.

**Step 7 — Ship**

Pi loads `finishing-a-development-branch`. It:
- Checks the commit history — clean or messy?
- If messy: `git rebase -i main` to squash into logical commits
- `git push -u origin HEAD`
- `gh pr create` with a properly formatted PR description
- `git worktree remove .worktrees/feature/oauth-login`

You get a PR URL. Done.

---

## The Context Budget

The footer shows `ctx:23%` at all times. When it hits 40%, you see `ctx:43% → subagent` — a nudge to offload the next large operation. At 60% it becomes `ctx:61% ⚠ offload` — actively stop reading large files or running commands in the main session.

This is why subagents exist. A scout reading 50 files eats maybe 30k tokens. If that happens in the main session, that's 30k tokens gone from your orchestration budget. In a subagent, it's isolated — the main session only sees the compressed summary.

---

## The Workflow Status Bar

The footer also shows where you are in the workflow:

```
✓research → ✓understand → ✓brainstorm → [plan] → execute → review → ship
```

It updates automatically as skills announce themselves. You always know which phase you're in.

---

## The Agents

| Agent | Model | Role |
|---|---|---|
| `scout` | haiku | Fast codebase recon — parallel sweeps |
| `researcher` | haiku | Docs, best practices, version lookups |
| `architect` | sonnet | Design decisions, ADRs |
| `implementer` | sonnet | TDD implementation, commits, self-review |
| `spec-reviewer` | sonnet | Gate 1 — did it match the spec? |
| `code-quality-reviewer` | sonnet | Gate 2 — is it well-written? |
| `security-reviewer` | sonnet | Gate 3 — any security issues? |
| `debugger` | sonnet | Root cause analysis, surgical fix |
| `reviewer` | sonnet | Final holistic review of entire branch |
| `documenter` | haiku | README, CHANGELOG, inline docs |
| `worker` | sonnet | Last-resort fallback |

Haiku agents run fast and cheap — they're in parallel sweeps and do straightforward work. Sonnet agents make decisions, write code, and review — quality matters more than cost there.

---

## The Skills

### Workflow skills (use in order)

```
brainstorming → writing-plans → subagent-driven-development → finishing-a-development-branch
```

| Skill | When to load |
|---|---|
| `research` | Before any new project or when adopting unfamiliar tech |
| `understand-codebase` | At the start of any session on an existing codebase |
| `brainstorming` | Before any feature work — explores intent, proposes approaches |
| `spec-writer` | For non-trivial features with behavioral complexity |
| `writing-plans` | After design is approved — creates implementation plan |
| `subagent-driven-development` | Execute a plan with three-gate review per task |
| `using-git-worktrees` | Before any implementation — isolated workspace |
| `finishing-a-development-branch` | After all tasks complete — squash, push, PR, cleanup |
| `pr-review` | Given a GitHub PR URL to review |
| `exa-search` | Semantic search, AI answers, doc page fetching |
| `brave-search` | Keyword web search, news, reference pages |
| `frontend-design` | Web pages, landing pages, marketing sites |
| `interface-design` | Dashboards, admin panels, application UI |

### Invoking skills

Skills load automatically when the task matches their description. Force-load with:

```
/skill:brainstorming
/skill:understand-codebase
/skill:writing-plans
/skill:subagent-driven-development
/skill:finishing-a-development-branch
/skill:pr-review
```

---

## The Greenfield Path

Same flow, different start. Instead of `understand-codebase`, begin with `research`:

Pi dispatches 3-5 researcher agents in parallel — each gets one focused question:
- What's the best framework for this in 2025?
- What's the current CLI scaffolding command?
- What are the standard packages in this ecosystem?
- Are there any known footguns or migration issues?

They run simultaneously and return findings. Pi synthesizes a **Research Brief** with a recommended stack, exact CLI commands, and key docs to reference. You confirm, then move into brainstorming with current information rather than stale training data.

---

## What You Do vs What Agents Do

**You (main session):**
- Answer questions during brainstorming
- Approve the design
- Approve the plan
- Watch execution and intervene if something goes wrong

**Agents (subprocesses):**
- Everything else: reading files, writing code, running tests, committing, reviewing, searching docs

The main session stays light. It orchestrates. The heavy lifting happens in isolated context windows that don't cost you budget.

---

## When Things Go Wrong

**Implementer fails (✗ in the panel):** Error reporting shows exit code, stderr, and last output before the crash. Dispatch `debugger` with the error output — it traces the root cause surgically.

**Spec-reviewer keeps failing:** The implementer is missing something from the spec. Pi re-dispatches the implementer with the reviewer's specific findings — not a vague "fix it" but exact issues.

**Security-reviewer flags something:** This is the point — find it here, not in production. Pi dispatches the implementer with the security findings, re-runs security review after the fix.

**Context budget hits 60%:** Stop reading files in the main session. Dispatch a scout to do the reading and return a summary.

---

## PR Review

Just paste a GitHub PR URL. The `/pr-review` prompt activates automatically, showing a widget with PR title and author. It:

1. Fetches full diff, all comments, all reviews, CI status via `gh` CLI
2. Reads every changed file in full
3. Reads callers, test files, related types
4. Flags unresolved review comments
5. Produces a structured review: Good / Bad / Ugly / Tests / Summary

---

## Setup Requirements

- [pi](https://github.com/badlogic/pi) installed
- `gh` CLI installed and authenticated (for pr-review)
- `EXA_API_KEY` in your shell profile (for exa-search)
- `BRAVE_API_KEY` in your shell profile (for brave-search)
- Run `npm install` in `skills/brave-search/`, `skills/exa-search/`, `skills/browser-tools/` before first use
