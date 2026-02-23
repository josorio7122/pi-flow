# Pi Agentic Development Workflow

> **This document defines the complete agent-driven development system for this pi setup.**
> Read this to understand the full workflow, all agents, all skills, and how they connect.
> This is the reference doc — AGENTS.md holds the operational rules, this holds the design.

---

## Table of Contents

1. [Philosophy](#1-philosophy)
2. [The Two Workflows](#2-the-two-workflows)
3. [Workflow Phases Deep Dive](#3-workflow-phases-deep-dive)
4. [Agent Roster](#4-agent-roster)
5. [Skill Roster](#5-skill-roster)
6. [Subagent Dispatch Rules](#6-subagent-dispatch-rules)
7. [Subagent Visibility](#7-subagent-visibility)
8. [Model Tier Assignments](#8-model-tier-assignments)
9. [Context Budget Rules](#9-context-budget-rules)
10. [Extension Layer](#10-extension-layer)
11. [System Map](#11-system-map)

---

## 1. Philosophy

**The agent is not a code writer. It is a software engineer.**

A software engineer understands a problem before designing a solution. They design before building. They review before shipping. They never write code without understanding why.

This workflow enforces that shape:

```
Understand → Specify → Plan → Execute → Review
```

Both for new projects and existing codebases. The phases are the same — only the inputs differ.

**Five components of every agent** (from production agentic engineering):
- **Prompt** — standing instructions (the agent file)
- **Tools** — what it can do
- **Context** — what it knows about this task
- **Memory** — what persists across turns (session)
- **Model** — which LLM tier it uses

All five are designed, not just the prompt.

**Core principles:**
- **CLI first** — always scaffold via official CLIs with `@latest`, never hand-write configs
- **Docs first** — look up current documentation before using any tool/framework
- **TDD** — failing test before implementation code, always
- **Fresh context per task** — subagents prevent context pollution
- **Two-stage review** — spec compliance then code quality, never skipped
- **Parallel where independent** — but only when no shared state
- **YAGNI** — build only what's needed
- **Idempotent SQL** — every SQL file must be safe to re-run; rewrite generated files immediately (see Phase 4)

---

## 2. The Two Workflows

### Workflow A: Greenfield (New Project)

```
┌─────────────────────────────────────────────────────────────────┐
│                    GREENFIELD WORKFLOW                          │
│                                                                 │
│  1. RESEARCH      Research product space, tech options,         │
│     & EXPLORE     best practices for the chosen stack           │
│         ↓                                                       │
│  2. BRAINSTORM    Understand intent, explore approaches,        │
│     & DESIGN      propose design, get approval                  │
│         ↓                                                       │
│  3. SPEC          Write complete behavioral specification        │
│     (optional     (for larger systems — GLOSSARY, DATA-MODEL,   │
│      for small)   subsystem specs, API contract)                │
│         ↓                                                       │
│  4. PLAN          Create task-by-task implementation plan       │
│     (writing-     with exact files, code, commands, TDD steps   │
│      plans)                                                     │
│         ↓                                                       │
│  5. SCAFFOLD      Set up worktree, use CLI tools to init        │
│     & SETUP       project, install deps, verify baseline        │
│         ↓                                                       │
│  6. EXECUTE       Dispatch subagents per task, three-gate       │
│     (subagent-    review after each: spec → quality → security  │
│      driven)                                                    │
│         ↓                                                       │
│  7. REVIEW        Final pass over entire implementation         │
│         ↓                                                       │
│  8. SHIP          Squash, push, open PR, remove worktree        │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

**When to use:** Starting from zero, building a new feature from scratch on a new codebase.

**Key difference from existing:** Research phase is broader — includes product exploration, stack selection, competitive landscape if needed.

---

### Workflow B: Existing Codebase

```
┌─────────────────────────────────────────────────────────────────┐
│                   EXISTING CODEBASE WORKFLOW                    │
│                                                                 │
│  1. UNDERSTAND    Multi-level codebase analysis:                │
│     CODEBASE      product, architecture, tech, dependencies     │
│         ↓                                                       │
│  2. UNDERSTAND    Clarify what the user wants, why,             │
│     INTENT        success criteria, constraints                 │
│         ↓                                                       │
│  3. BRAINSTORM    Design the change: how does it fit            │
│     & DESIGN      existing architecture? What touches what?     │
│         ↓                                                       │
│  4. SPEC          Define expected behavior precisely            │
│     (if non-      (skip for trivial changes, required for       │
│      trivial)     anything with cross-cutting effects)          │
│         ↓                                                       │
│  5. PLAN          Task breakdown — surgical, minimal blast      │
│     (writing-     radius, explicit file list per task           │
│      plans)                                                     │
│         ↓                                                       │
│  6. WORKTREE      Isolated git workspace, never on main         │
│         ↓                                                       │
│  7. EXECUTE       Subagent per task, three-gate review          │
│         ↓                                                       │
│  8. REVIEW        Final review of entire changeset              │
│         ↓                                                       │
│  9. SHIP          Squash, push, open PR, remove worktree        │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

**When to use:** Feature addition, bug fix, refactor, or migration on an existing codebase.

**Key difference from greenfield:** Understanding phase uses scouts at multiple levels simultaneously (parallel dispatch).

---

## 3. Workflow Phases Deep Dive

### Phase 0: Research (Greenfield only, or when stack is new)

**Trigger:** New project, unfamiliar stack, or "what's the best way to do X?"

**What happens:**
- `researcher` subagents run in parallel for different concerns
  - Stack options + tradeoffs
  - Best practices for chosen tools
  - CLI scaffolding commands (always `@latest`)
  - Current documentation for any libs being adopted
- Results surface to main session before any design decision is made

**Output:** Structured findings — options with tradeoffs, recommended stack, key docs links, CLI commands to use.

**Skills:** `exa-search`, `brave-search`

---

### Phase 1: Understanding (Existing codebase)

**Trigger:** Any work on an existing codebase, user brings a request.

**Multi-level understanding — all scanned in parallel:**

| Level | What | Agent |
|---|---|---|
| Product | What does this product do? Who uses it? What's the core workflow? | `scout` |
| Architecture | How is it structured? Layers, boundaries, key modules? | `scout` |
| Tech | What stack, frameworks, versions, build system? | `scout` |
| Dependencies | What packages? Any outdated/deprecated/risky ones? | `researcher` |
| Relevant code | What files/modules touch the area we're changing? | `scout` |

**Output:** A structured brief covering all five levels. This is what the main session uses for design — not raw files.

---

### Phase 2: Brainstorm & Design

**Skill:** `brainstorm`

**What happens:**
- One question at a time to clarify intent
- Propose 2-3 approaches with tradeoffs
- Present design section by section, get approval after each
- Write approved design to `docs/plans/YYYY-MM-DD-name-design.md`
- Commit design doc

**Non-negotiable:** No implementation before design is approved. No exceptions for "simple" changes.

---

### Phase 3: Spec Writing (Non-trivial features)

**Skill:** `spec`

**When required:**
- New subsystem or major feature
- API contract changes
- Data model changes
- Cross-cutting behavior (auth, errors, pagination)
- Anything affecting multiple teams/consumers

**When optional (skip with user consent):**
- Small isolated features
- Bug fixes
- Pure refactors with no behavior change

**Output:** `GLOSSARY.md`, `CONSTITUTION.md`, `DATA-MODEL.md`, subsystem specs, API contract, UI spec.

---

### Phase 4: Implementation Plan

**Skill:** `plan`

**What it produces:**
- Task-by-task breakdown with exact files
- Full code for each step (not "add validation" — actual code)
- TDD steps: write test → verify fail → implement → verify pass → commit
- Exact commands with expected output
- Blast radius estimate per task (how many files touched)

**Blast radius guidance (from production agentic engineering):**
- 1-5 files: safe for parallel agent dispatch
- 6-20 files: single agent with monitoring
- 20+ files: break into smaller tasks or request options first

**Idempotent SQL rule — mandatory for every SQL file:**

Any time a CLI tool generates a SQL migration file (drizzle-kit generate, alembic revision, flyway, sqitch, etc.) — read the file immediately and rewrite every statement to be safe to re-run:

| Statement | Idempotent form |
|-----------|----------------|
| `CREATE TABLE` | `CREATE TABLE IF NOT EXISTS` |
| `CREATE INDEX` | `CREATE INDEX IF NOT EXISTS` |
| `CREATE TYPE` (Postgres enum) | `DO $$ BEGIN ... EXCEPTION WHEN duplicate_object THEN NULL; END $$` |
| `ALTER TABLE ... ADD COLUMN` | `DO $$ BEGIN ... EXCEPTION WHEN duplicate_column THEN NULL; END $$` |
| `ALTER TABLE ... ADD CONSTRAINT` | `DO $$ BEGIN ... EXCEPTION WHEN duplicate_object THEN NULL; END $$` |
| `DROP TABLE` | `DROP TABLE IF EXISTS` |
| `DROP INDEX` | `DROP INDEX IF EXISTS` |
| `DROP COLUMN` | `ALTER TABLE ... DROP COLUMN IF EXISTS` |

Applies to **every** generated migration without exception — including the first one. A migration that errors on re-run breaks CI, team onboarding, and disaster recovery.

---

### Phase 5: Worktree Setup

**Skill:** `worktree`

**Always before implementation.** Never on main/master.

**One worktree per feature.** All parallel implementers working on the same feature share the same worktree — pass the same `cwd` to every implementer subagent. Never create a separate worktree per task or per implementer. Separate worktrees branch off independently and produce merge conflicts when recombined.

---

### Phase 6: Execution

**Skill:** `execute`

**Per-task loop:**
```
implementer → spec-reviewer → [fix if needed] → code-reviewer → [fix if needed] → ✅ done
```

**Parallel dispatch rules** (see Section 6 for full decision matrix):
- Independent tasks with no shared state → parallel
- Tasks touching same files → sequential
- Research/recon tasks → always parallel

---

### Phase 7: Final Review

**Agent:** `branch-reviewer`

After all tasks complete, a final reviewer reads the entire diff and implementation summary.

---

## 4. Agent Roster

All agents live in `~/.pi/agent/extensions/subagent/agents/`. Each has a single responsibility and a bounded set of tools.

---

### `scout` — Codebase Reconnaissance
**Model:** `claude-haiku-4-6` (fast, cheap)
**Tools:** `read`, `bash` (read-only), `grep`, `find`, `ls`
**Purpose:** Fast, thorough codebase investigation. Returns compressed findings for handoff to other agents. Never modifies files. Used in parallel sweeps.
**Input:** A focused question ("find all auth-related code and return a structured summary")
**Output:** Structured findings that a downstream agent can use without re-reading files

---

### `researcher` — Documentation & Best Practices Lookup
**Model:** `claude-haiku-4-6` (fast, cheap)
**Tools:** `bash` (for exa-search/brave-search scripts)
**Purpose:** Looks up current documentation, compares options, checks changelogs, finds best practices. Fires before implementation, results inform design. Never implements anything.
**Input:** A specific research question ("what is the current best practice for X in Y v3?")
**Output:** Structured findings with sources — options, tradeoffs, recommended approach, relevant doc links

---

### `architect` — System Design & ADRs
**Model:** `claude-sonnet-4-6`
**Tools:** `read`, `grep`, `find`, `ls`
**Purpose:** Given requirements and codebase context, produces system design decisions: component breakdown, data models, API contracts, architectural tradeoffs. Writes Architecture Decision Records (ADRs). Does NOT write implementation code.
**Input:** Requirements + scout findings
**Output:** Design document or ADR — decisions made, alternatives considered, rationale

---

### `implementer` — TDD Implementation
**Model:** `claude-sonnet-4-6`
**Tools:** `read`, `bash`, `edit`, `write`, `grep`, `find`, `ls`
**Purpose:** Implements exactly one task from a plan. Follows TDD strictly: failing test first, minimal implementation, commit. Self-reviews before reporting. Never goes beyond the task spec.
**Input:** Full task text (not the plan file) + all needed context
**Output:** Implementation committed to git — tests passing, self-review report

---

### `debugger` — Targeted Bug Fixing
**Model:** `claude-sonnet-4-6`
**Tools:** `read`, `bash`, `edit`, `grep`, `find`, `ls`
**Purpose:** Given failing tests + error output + relevant files, traces root cause and produces a surgical fix. Never rewrites — minimal targeted edits only. Does not commit (implementer commits after review).
**Input:** Test output, error messages, relevant file paths
**Output:** Root cause analysis + targeted fix with explanation

---

### `spec-reviewer` — Spec Compliance Gate
**Model:** `claude-sonnet-4-6`
**Tools:** `read`, `bash` (read-only)
**Purpose:** Verifies implementation matches spec exactly — nothing missing, nothing extra. Reads actual code, does not trust the implementer's report. This is the first review gate.
**Input:** Requirements text + implementer report + commit SHA
**Output:** ✅ compliant or ❌ specific issues list

---

### `code-reviewer` — Quality Gate
**Model:** `claude-sonnet-4-6`
**Tools:** `read`, `bash` (read-only)
**Purpose:** Reviews code quality after spec compliance is confirmed. Checks: clean code, good tests, proper error handling, naming, architecture fit. Second review gate — only runs after spec-reviewer passes.
**Input:** Implementer report + base/head SHAs
**Output:** ✅ approved or ❌ specific quality issues

---

### `security-reviewer` — Security Gate
**Model:** `claude-sonnet-4-6`
**Tools:** `read`, `bash` (read-only)
**Purpose:** Read-only security audit of a diff. Checks: hardcoded secrets, injection vectors, auth gaps, unsafe dependencies, OWASP issues. Optional gate — triggered on auth changes, API changes, or by user request.
**Input:** Diff or commit SHA range
**Output:** PASS/FAIL + specific findings with severity

---

### `documenter` — Documentation Updates
**Model:** `claude-haiku-4-6` (cheap)
**Tools:** `read`, `bash`, `edit`, `write`, `grep`, `find`, `ls`
**Purpose:** Given a diff + existing docs, updates README, CHANGELOG, inline comments, API docs. Commits documentation changes separately from implementation. Runs after all tasks complete.
**Input:** Implementation summary + existing doc files
**Output:** Updated docs committed

---

### `branch-reviewer` — Final Implementation Review
**Model:** `claude-sonnet-4-6`
**Tools:** `read`, `bash` (read-only)
**Purpose:** Final review of entire feature implementation. Reviews the full diff against the original plan — checks consistency, integration, edge cases. Used as the last step before PR.
**Input:** Full implementation summary + plan + diff
**Output:** Approval or issues list with recommendations

---

### `worker` — General Purpose Fallback
**Model:** `claude-sonnet-4-6`
**Tools:** all
**Purpose:** Last-resort agent for tasks that don't fit any specialist. Use sparingly — prefer specialist agents. Good for one-off scripts, ad-hoc investigation, or tasks that span multiple concerns in a single isolated context.
**Input:** Any task with full context provided
**Output:** Completed task with notes

---

### Agent Selection Quick Reference

| I need to... | Use |
|---|---|
| Investigate a codebase | `scout` |
| Look up docs / best practices | `researcher` |
| Design a system | `architect` |
| Implement a task | `implementer` |
| Fix a failing test | `debugger` |
| Check spec compliance | `spec-reviewer` |
| Check code quality | `code-reviewer` |
| Check for security issues | `security-reviewer` |
| Update docs/README | `documenter` |
| Final feature review | `branch-reviewer` |
| Anything else | `worker` (last resort) |

---

## 5. Skill Roster

Skills are loaded on-demand. The description in the frontmatter determines when the agent loads them automatically. You can also force-load with `/skill:name`.

### Research Skills
| Skill | When | What it does |
|---|---|---|
| `exa-search` | Looking up docs, best practices, current versions | Neural search + direct AI answers + URL content fetch |
| `brave-search` | Keyword-based doc lookups, news, specific terms | Web search + page content extraction |

### Design Skills
| Skill | When | What it does |
|---|---|---|
| `brainstorm` | Before ANY feature work | Explores intent → proposes approaches → gets design approved |
| `spec` | For non-trivial features with behavioral complexity | Produces full SDD spec: glossary, data model, API contract, UI spec |

### Planning Skills
| Skill | When | What it does |
|---|---|---|
| `plan` | After design approved, before touching code | Creates task-by-task plan with TDD steps, exact files, exact commands |

### Execution Skills
| Skill | When | What it does |
|---|---|---|
| `worktree` | Before any implementation | Sets up isolated git workspace, verifies baseline |
| `execute` | Executing plan in this session | Dispatches subagents per task, three-gate review loop |
| `ship` | After all tasks complete | Squash commits, push, open PR, remove worktree |

### Review Skills
| Skill | When | What it does |
|---|---|---|
| `pr-review` | Given a GitHub PR URL | Fetches full diff, comments, CI status, reviews against standards |

### UI Skills
| Skill | When | What it does |
|---|---|---|
| `frontend-design` | Building web pages, landing pages, marketing | High-quality frontend UI code, avoids generic AI aesthetics |
| `interface-design` | Building dashboards, apps, admin panels | Application UI with consistency system |

---

## 6. Subagent Dispatch Rules

**The most important rule:** Subagents exist primarily for context isolation, not just parallelism. A subagent's isolated context window prevents "context pollution" — noisy operations (large file reads, test output, web search) eating the parent session's token budget.

### Parallel Dispatch — ALL conditions must be true

- 3 or more independent tasks
- No shared state between tasks (different files, different modules)
- Clear output boundaries (each agent produces self-contained output)
- No dependency (task B does not need task A's output as input)

```
# Good parallel: independent scouts
subagent(tasks: [
  { agent: "scout", task: "Find all auth code" },
  { agent: "scout", task: "Find all API endpoints" },
  { agent: "researcher", task: "Look up JWT best practices 2025" }
])

# Good parallel: independent implementers — SAME cwd (shared worktree)
subagent(tasks: [
  { agent: "implementer", task: "Task 1: ...", cwd: "/project/.worktrees/feature/my-feat" },
  { agent: "implementer", task: "Task 2: ...", cwd: "/project/.worktrees/feature/my-feat" },
])

# ❌ Wrong: separate worktrees per implementer — causes merge conflicts
subagent(tasks: [
  { agent: "implementer", task: "Task 1: ...", cwd: "/project/.worktrees/feature/task-1" },
  { agent: "implementer", task: "Task 2: ...", cwd: "/project/.worktrees/feature/task-2" },
])
```

### Sequential Dispatch (chain) — ANY condition triggers this

- Task B needs output from Task A
- Tasks touch the same files
- Order matters for correctness

```
# Good chain: scout findings feed architect
subagent(chain: [
  { agent: "scout", task: "Investigate auth module" },
  { agent: "architect", task: "Design solution based on: {previous}" }
])
# Planning then happens in the main session via plan skill
```

### Single Dispatch

- One task, no dependencies, doesn't qualify for parallel
- A fix based on a reviewer's specific findings

### Background (fire and collect)

- Research tasks that don't block design
- Documentation lookups where you need the answer "eventually"
- Use parallel dispatch with 1-2 researcher agents, collect when ready

### Context Budget Rule

**Deploy a subagent when context utilization reaches 40-60%.**

Signs you should offload to a subagent instead of continuing in main session:
- About to do a large file scan
- About to run tests and capture all output
- About to do web research
- Working on task 3+ of a multi-task plan

Check context with `ctx.getContextUsage()` from extensions, or use judgment based on session length.

### Over-Parallelization Warning

More parallel agents ≠ better. 3-4 well-scoped parallel agents is usually optimal. Launching 8 agents for a simple feature wastes tokens with no benefit. Match parallelism to actual independence.

---

## 7. Subagent Visibility

You can see what subagents are doing in real time. The pi subagent tool shows:

**Collapsed view (default):**
- Status icon: ⏳ running / ✓ done / ✗ failed
- Agent name and last few tool calls
- Token usage and cost per agent

**Expanded view (Ctrl+O):**
- Full task text given to agent
- Every tool call with formatted arguments
  - `$ command` for bash
  - `read ~/path:1-10` for read
  - `grep /pattern/ in ~/path` for grep
- Full final output rendered as Markdown
- Per-agent usage stats

**Parallel mode:**
- All agents show simultaneously with live updates
- `2/3 done, 1 running` status
- Each agent streams updates as it works

This means: when you dispatch scouts in parallel, you watch all three working simultaneously. When the implementer runs tests, you see the bash calls and output. No black boxes.

---

## 8. Model Tier Assignments

| Tier | Model | Used for |
|---|---|---|
| **Fast + cheap** | `claude-haiku-4-6` | `scout`, `researcher`, `documenter` |
| **Full capability** | `claude-sonnet-4-6` | `implementer`, `architect`, `debugger`, all reviewers, `worker` |

**Why this matters:**
- `scout` and `researcher` run in parallel, often multiple at once — Haiku keeps cost down
- `documenter` does straightforward text work — Haiku is sufficient
- All agents that make decisions or write code use Sonnet — quality matters more than cost there
- No Opus by default — Sonnet handles everything in this workflow

---

## 9. Context Budget Rules

| Context used | Action |
|---|---|
| < 40% | Continue in main session |
| 40-60% | Offload next large operation to subagent |
| > 60% | Actively offload — no more large reads or command output in main session |
| Approaching limit | Pi auto-compacts — session summary replaces full history |

**What to offload first:**
1. Large file scans → `scout`
2. Test output capture → `implementer` (already in subagent)
3. Web research → `researcher`
4. Documentation updates → `documenter`

---

## 10. Extension Layer

Extensions add persistent behavior to every session without polluting the agent's context. These live in `~/.pi/agent/extensions/`.

### Planned Extensions

**`git-checkpoint.ts`** (already exists as example) — Auto git stash on turns
- Stashes at each turn, restores on fork
- Safety net during implementation

**`session-namer.ts`** — Names sessions automatically
- Sets session name from first user message
- Makes session history navigable

### How to Add Extensions

Place `.ts` files in `~/.pi/agent/extensions/`. They load automatically. No compilation needed — pi uses jiti.

---

## 11. System Map

```
┌──────────────────────────────────────────────────────────────────────┐
│                          PI SESSION (main)                           │
│                                                                      │
│  SKILLS (loaded on-demand)          EXTENSIONS (always active)       │
│  ┌─────────────────────────┐        ┌──────────────────────────┐     │
│  │ exa-search              │        │ pr-review                │     │
│  │ brave-search            │        └──────────────────────────┘     │
│  │ brainstorm           │                                         │
│  │ spec             │                                         │
│  │ plan           │                                         │
│  │ worktree     │                                         │
│  │ subagent-driven-dev     │                                         │
│  │ finishing-a-dev-branch  │                                         │
│  │ pr-review               │                                         │
│  └─────────────────────────┘                                         │
│                                                                      │
│  SUBAGENT DISPATCH (isolated context windows)                        │
│  ┌────────────┐  ┌─────────────┐  ┌────────────┐  ┌─────────────┐  │
│  │   scout    │  │ researcher  │  │  architect │  │ implementer │  │
│  │  (haiku)   │  │  (haiku)    │  │  (sonnet)  │  │  (sonnet)   │  │
│  └────────────┘  └─────────────┘  └────────────┘  └─────────────┘  │
│                                                                      │
│  ┌─────────────┐  ┌────────────┐  ┌────────────┐  ┌─────────────┐  │
│  │   debugger  │  │  reviewer  │  │  documenter│  │   worker    │  │
│  │  (sonnet)   │  │  (sonnet)  │  │  (haiku)   │  │  (sonnet)   │  │
│  └─────────────┘  └────────────┘  └────────────┘  └─────────────┘  │
│                                                                      │
│  ┌──────────────────┐  ┌───────────────────────┐  ┌─────────────┐  │
│  │  spec-reviewer   │  │ code-reviewer │  │  security-  │  │
│  │    (sonnet)      │  │       (sonnet)        │  │  reviewer   │  │
│  └──────────────────┘  └───────────────────────┘  │  (sonnet)   │  │
│                                                    └─────────────┘  │
│                                                                      │
│  ┌─────────────┐                                                     │
│  │  documenter │                                                     │
│  │   (haiku)   │                                                     │
│  └─────────────┘                                                     │
└──────────────────────────────────────────────────────────────────────┘

WORKFLOW PHASES:
─────────────────────────────────────────────────────────────────────
GREENFIELD:  research → brainstorm → [spec] → plan → worktree → execute → review → ship
EXISTING:    [understand] → brainstorm → [spec] → plan → worktree → execute → review → ship

EXECUTION LOOP (per task):
─────────────────────────────────────────────────────────────────────
implementer → spec-reviewer → [fix] → code-reviewer → [fix] → security-reviewer → [fix] → ✅

UNDERSTAND PHASE (parallel):
─────────────────────────────────────────────────────────────────────
scout(product) ──┐
scout(arch)    ──┼──→ main session (synthesize findings)
scout(tech)    ──┤
researcher(deps)─┘
```

---

## Appendix: What Changes From Previous Setup

### New agents added
- `researcher` — doc lookup and best practices (was done inline, now isolated)
- `architect` — system design (was done inline, now a dedicated agent)
- `debugger` — targeted fixes (was done by implementer, now specialized)
- `security-reviewer` — security audit gate (new)
- `documenter` — doc updates (new)

### Agents renamed/updated
- All agents: model updated from `claude-sonnet-4-5` to `claude-sonnet-4-6`
- `scout`: model updated to `claude-haiku-4-6`
- `worker`: clarified as last-resort fallback, not default

### New AGENTS.md rules
- Subagent dispatch decision matrix (parallel/sequential/single/background)
- Context budget rule (40-60% → offload)
- CLI-first tooling table
- Always check current docs rule

### Skills in workflow
- `brainstorm`, `plan`, `execute`
- `worktree`, `ship`, `pr-review`
- `explore`, `research`, `spec`
- `exa-search`, `brave-search`, `frontend-design`, `interface-design`

### Skills removed (redundant)
- `executing-plans` — `execute` in a fresh session is strictly better
- `test-driven-development` — TDD enforced by `implementer` agent and `plan` steps
- `cursor` — three bash commands; not a workflow skill
