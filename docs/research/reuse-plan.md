# pi-flow v2 Reuse Plan

> What to take from each repo, how to adapt it, and what to build new.

---

## pi-flow Vision Recap

pi-flow is an **intelligent workflow engine** built ON TOP of the existing sub-agent system. The existing agent spawning (`runAgent`, `createAgentManager`, `createRegistry`, `createAgentSession`) stays untouched — workflows are a new orchestration layer that uses those primitives.

The LLM orchestrator observes user intent, selects the right workflow, triggers agents through the existing system, manages context passing between them, and gives the user full visibility + approval gates.

### Workflows (ordered by complexity)

| Level | ID | Intent | Phases | Agents |
|-------|----|--------|--------|--------|
| Simple | **W1** | Research/verify | Probe → Report | probe |
| Simple | **W2** | Understand code | Explore → Summary → User decides | explorer |
| Medium | **W3** | Simple fix | Scout → Report → Approve → Build → Review → Report | scout, builder, reviewer |
| Complex | **W4** | Complex feature | Clarify (SDD) → Plan → Test (red) → Build (green) → Review loop → Report | clarifier, planner, test-writer, builder, reviewer |

### Agent Roles

| Role | What it does | Tools |
|------|-------------|-------|
| **Probe** | Research/verification — DB queries, web search, docker | bash, exa, docker tools |
| **Explorer** | Deep-reads codebase, produces understanding report | read, grep, find, ls, bash (read-only) |
| **Scout** | Reads codebase, finds relevant code, produces targeted analysis | read, grep, find, ls, bash (read-only) |
| **Clarifier** | Asks user questions, builds SDD (Spec-Driven Design) | read, bash (read-only), user questions |
| **Planner** | Creates structured plan from understanding | read, bash (read-only) |
| **Test-writer** | Writes failing tests from spec (red phase) | read, write, edit, bash |
| **Builder** | Implements code to make tests pass (green phase) | read, write, edit, bash |
| **Reviewer** | Checks work against spec+plan, produces verdict | read, grep, find, bash (read-only) |

### System Requirements

1. **Smart routing** — orchestrator LLM decides workflow, not hardcoded
2. **Context sharing** — agent outputs feed into next agent's prompt
3. **Resilience** — failure recovery, auto-continue with context
4. **Visibility** — dashboard, progress, active agents, what each is doing
5. **Human-in-the-loop** — approve plans, review results, decide commits
6. **Cost awareness** — track token usage, budget limits

### Key Constraint

**The sub-agent system does NOT change.** pi-flow already has:
- `runAgent()` in `agents/runner.ts` — spawns agents via `createAgentSession()` (SDK)
- `createAgentManager()` in `agents/manager.ts` — manages agent lifecycle
- `createRegistry()` in `agents/registry.ts` — agent type configs with tools
- Agent configs from markdown frontmatter in `agents/defaults.ts` + `agents/custom.ts`

Workflows use these existing primitives. The new code is the orchestration layer: deciding WHICH agents to spawn, in WHAT order, with WHAT context, and HOW to handle their results.

---

## Reuse Analysis

### Layer 1: Workflow Types & State (Adapt from pi-coordination)

The pipeline engine — phase tracking, cost tracking, state persistence.

| Source | What | Why | Adaptation |
|--------|------|-----|------------|
| **pi-coordination** `coordinate/types.ts` | `PipelinePhase`, `PipelineState`, `PhaseResult`, `CostState` | Type foundations for workflow tracking | Adapt phase names to ours (probe, explore, scout, clarify, plan, test, build, review). Keep `CostState` as-is. |
| **pi-coordination** `coordinate/pipeline.ts` | `initializePipelineState()`, `updatePhaseStatus()`, `checkCostLimit()`, `runReviewFixLoop()` | Phase state machine, cost limit checking, review-fix loop with stuck detection | Strip observability noise. Keep: phase transitions, cost tracking, `runReviewFixLoop()` (this IS W3's review cycle). ~250 lines from 817. |
| **pi-coordination** `coordinate/checkpoint.ts` | `CheckpointManager` | Save/restore workflow state across crashes | Simplify — 102 lines, mostly direct reuse |
| **pi-coordination** `coordinate/progress.ts` | `generateProgressDoc()` | Human-readable progress document | Adapt to our phase names. ~100 lines from 208. |

**Key insight:** pi-coordination's `runReviewFixLoop()` is exactly what W3 and W4 need — review → detect issues → fix → re-review → until clean or stuck. The `detectStuckIssues()` function (15 lines) prevents infinite loops.

---

### Layer 2: Task Management (Adapt from pi-messenger, simpler)

pi-coordination's `TaskQueueManager` (406 lines with file locking, subtasks, priority queues) is overkill. pi-messenger's crew store is closer to what we need.

| Source | What | Why | Adaptation |
|--------|------|-----|------------|
| **pi-messenger** `crew/store.ts` | Task CRUD, plan storage, progress tracking, `getReadyTasks()` | Simple task model: `{ id, title, description, status, dependencies, files }`. Dependency-aware readiness check. | Strip messenger-specific fields (assigned_to, base_commit, lobby). Keep: create, update, getReadyTasks, dependency resolution. ~200 lines from 613. |
| **pi-messenger** `crew/task-actions.ts` | `startTask`, `completeTask`, `blockTask`, `resetTask` | Clean state transitions | Direct copy + type adaptation. 123 lines. |
| **pi-manage-todo-list** `state-manager.ts` | Validation pattern, stats computation | For W1/W2 where tasks are simple (no dependency graph needed) | Use as inspiration for lightweight tracking |

---

### Layer 3: Context Sharing Between Agents (Adapt from pi-coordination)

Critical — agents must NOT start from scratch. The scout's output feeds the builder, the reviewer's issues feed back to the builder, etc.

| Source | What | Why | Adaptation |
|--------|------|-----|------------|
| **pi-coordination** `coordinate/worker-context.ts` | `WorkerContext`, `loadContext()`, `saveContext()`, `updateContext()` | Per-task context persistence. Tracks: files modified, discoveries, attempt history. Survives agent restarts. | Generalize from "worker" to "agent" context. Add: structured handoff (previous agent's output becomes next agent's input). ~150 lines from 654. |
| **pi-coordination** `coordinate/auto-continue.ts` | `processWorkerExit()`, continuation prompt building | When agent fails: load context.md → analyze what was done → build restart prompt: "Don't redo X, fix Y at line Z" | Adapt to our agent roles. The pattern is universal — any agent can fail. ~100 lines from 362. |

**Build new:**
- `AgentHandoff` type — structured output from one agent that becomes input for the next:
  ```ts
  interface AgentHandoff {
    fromRole: AgentRole
    toRole: AgentRole
    summary: string
    findings: string       // the agent's main output
    filesAnalyzed: string[]
    filesModified: string[]
    context: string        // anything the next agent needs to know
  }
  ```
- `buildAgentPrompt(role, task, handoff, plan)` — assembles prompt from workflow state + previous handoff

---

### Layer 4: Review System (Take from pi-messenger)

| Source | What | Why | Adaptation |
|--------|------|-----|------------|
| **pi-messenger** `crew/utils/verdict.ts` | `parseVerdict()` → SHIP / NEEDS_WORK / MAJOR_RETHINK | Simple, clear verdict model. 55 lines, pure function. | Direct copy. This IS our review output format. |
| **pi-messenger** `crew/handlers/review.ts` | `reviewImplementation()` — get diff → build prompt → spawn reviewer → parse verdict | The review workflow pattern | Adapt to use our `runAgent()` instead of messenger's `spawnAgents()` |
| **pi-coordination** `coordinate/pipeline.ts` | `detectStuckIssues()` | Detect when same issues keep appearing across review cycles | Direct copy — 15 lines, pure function |

**Our review model:**
```
Verdict: SHIP | NEEDS_WORK | MAJOR_RETHINK
Issues: [{ file, line?, description, severity }]
Summary: string
```
- **SHIP** → workflow complete, report to user
- **NEEDS_WORK** → feed issues to builder, re-review (max N cycles)
- **MAJOR_RETHINK** → escalate to user, plan may need revision

---

### Layer 5: Visibility & Dashboard (Adapt from multiple)

| Source | What | Why | Adaptation |
|--------|------|-----|------------|
| **pi-manage-todo-list** `ui/todo-widget.ts` | `updateWidget()` — render lines with status icons, `ctx.ui.setWidget()` | Clean widget pattern for workflow progress | Direct pattern reuse — render phase pipeline + task status as widget |
| **pi-coordination** `coordinate/render-utils.ts` | `formatDuration`, status icons, phase timeline rendering | TUI formatting helpers | Cherry-pick: duration formatting, status icons, phase bar. ~50 lines from 694. |
| **pi-coordination** `coordinate/progress.ts` | `generateProgressDoc()` | Structured progress for the workflow | Adapt phase names |
| **pi-coordination** `coordinate/dashboard.ts` | `MiniFooter` — compact status in footer | Status bar: `[flow] scout ● 2/5 tasks | $0.45 | 2m30s` | Study pattern, build simpler version |

**Visibility model (v1):**
1. **Widget** (always visible): Phase pipeline + active agents + task progress
2. **Status bar**: `[flow] build ● 3/5 tasks | $0.45`
3. **`/flow` command**: Detailed progress, intervention options

---

### Layer 6: Human-in-the-Loop (Adapt from pi-planner)

| Source | What | Why | Adaptation |
|--------|------|-----|------------|
| **pi-planner** `mode/hooks.ts` | Tool restriction via `setActiveTools` + `tool_call` hook enforcement | During scout/review phases, agents shouldn't modify files. Dual-layer: hide tools + enforce via hook. | Direct pattern reuse — restrict tools per agent role |
| **pi-planner** `index.ts` → approval flow | User approves plan before execution. Uses `ctx.ui.select()` for approve/reject. | Human approval is core to pi-flow (after plan creation, after review) | Adapt approval points to our workflow phases |
| **pi-planner** `executor/stalled.ts` | Stalled detection (timeout-based) | Detect agents stuck in executing state | Direct copy — 34 lines |

---

### Layer 7: Resilience (Adapt from pi-coordination)

| Source | What | Why | Adaptation |
|--------|------|-----|------------|
| **pi-coordination** `coordinate/supervisor.ts` | Stuck detection pattern: check activity → nudge → restart → abandon | Agents can get stuck. Need automated detection + recovery. | Don't need the full class. Take the pattern: check last activity timestamp → if stale → steer message → if still stale → restart agent. ~60 lines. |
| **pi-coordination** `coordinate/auto-continue.ts` | Smart restart with context from previous attempt | When builder fails: "here's what was done, here's the error, fix this" | Covered in Layer 3 above |

---

## What to Build New (Not in Any Repo)

| Component | Why it's new | Description |
|-----------|-------------|-------------|
| **Workflow Router** | No repo has LLM-based intent classification | The orchestrator tool analyzes user intent and selects W1-W4. Uses the LLM itself via tool description guidance — not a hardcoded switch. |
| **SDD Clarifier** | No repo does spec-driven design | Interactive clarification: ask questions until the spec is complete. Different from pi-coordination's interview (which is planning-focused). |
| **Test-Writer Agent** | No repo has TDD as a first-class phase | Agent reads the plan, writes failing tests. Runs tests to confirm red. |
| **Red-Green Verification** | No repo verifies test state transitions | After test-writer (red) and builder (green), verify tests transitioned from failing to passing. Not just "tests pass" — they must have been red first. |
| **Agent Handoff Protocol** | All repos use ad-hoc context passing | Structured `AgentHandoff` type. Each agent produces a handoff that becomes the next agent's prompt context. |
| **Workflow Orchestrator** | All repos use either linear pipelines or task graphs | We need both: the workflow is a phase sequence (W1-W4), but within W4's build phase there can be parallel tasks. The orchestrator is an LLM that manages transitions. |

---

## Implementation Priority

### Phase 1: Foundation (types + pipeline + context + visibility)

| # | Component | Source | LOC est |
|---|-----------|--------|---------|
| 1 | Workflow types (phases, state, cost, handoff, verdict) | pi-coordination types + new | ~150 |
| 2 | Pipeline engine (phase tracking, cost, transitions) | pi-coordination pipeline.ts | ~250 |
| 3 | Verdict parsing (SHIP/NEEDS_WORK/MAJOR_RETHINK) | pi-messenger verdict.ts | ~55 |
| 4 | Agent context persistence + handoff | pi-coordination worker-context.ts | ~150 |
| 5 | Progress widget | pi-manage-todo-list widget.ts | ~80 |
| 6 | Output truncation | pi-coordination truncate.ts | ~120 |
| 7 | Stalled detection | pi-planner stalled.ts | ~34 |

**~840 lines. Provides: type system, phase machine, context sharing, visibility.**

### Phase 2: Simple Workflows (W1 + W2)

| # | Component | Source | LOC est |
|---|-----------|--------|---------|
| 8 | Agent role configs (probe, explorer .md files) | pi-coordination agents/*.md | ~100 |
| 9 | W1: Research/verify (probe → report) | New | ~80 |
| 10 | W2: Understand code (explore → summary) | New | ~80 |
| 11 | Workflow router tool | New | ~150 |
| 12 | Tool restriction per role | pi-planner mode/hooks.ts | ~80 |

**~490 lines. Delivers: working W1 + W2 + router.**

### Phase 3: Medium Workflow (W3)

| # | Component | Source | LOC est |
|---|-----------|--------|---------|
| 13 | Agent role configs (scout, builder, reviewer .md) | pi-coordination agents/*.md | ~150 |
| 14 | W3: Simple fix (scout → approve → build → review) | New + pi-coordination phases | ~200 |
| 15 | Review-fix loop | pi-coordination pipeline.ts | ~80 |
| 16 | Stuck issue detection | pi-coordination pipeline.ts | ~15 |
| 17 | Smart restart / auto-continue | pi-coordination auto-continue.ts | ~100 |
| 18 | Human approval gates | pi-planner index.ts | ~80 |

**~625 lines. Delivers: working W3 with review loop + approval.**

### Phase 4: Complex Workflow (W4)

| # | Component | Source | LOC est |
|---|-----------|--------|---------|
| 19 | Agent role configs (clarifier, planner, test-writer .md) | New | ~150 |
| 20 | SDD Clarifier | New (study pi-coordination interview.ts) | ~200 |
| 21 | Task store with dependencies | pi-messenger crew/store.ts | ~200 |
| 22 | Task actions (state transitions) | pi-messenger crew/task-actions.ts | ~123 |
| 23 | W4: Complex feature (full pipeline) | New | ~300 |
| 24 | Test-writer + red-green verification | New | ~200 |
| 25 | Parallel builder execution | Study pi-messenger crew/spawn.ts | ~150 |
| 26 | Dashboard (`/flow` command) | Study pi-coordination dashboard.ts | ~300 |
| 27 | Cost control | pi-coordination pipeline.ts | ~50 |

**~1,673 lines. Delivers: full W4 with TDD, parallel execution, dashboard.**

---

## File-Level Reuse Map

### From pi-coordination

```
ADAPT  coordinate/types.ts         → src/workflow/types.ts          (phase, cost, task types)
ADAPT  coordinate/pipeline.ts      → src/workflow/pipeline.ts       (phase machine, review-fix loop)
ADAPT  coordinate/checkpoint.ts    → src/workflow/checkpoint.ts     (state persistence)
ADAPT  coordinate/progress.ts      → src/workflow/progress.ts       (progress doc generation)
ADAPT  coordinate/worker-context.ts→ src/workflow/agent-context.ts  (context persistence + handoff)
ADAPT  coordinate/auto-continue.ts → src/workflow/recovery.ts       (smart restart logic)
COPY   subagent/truncate.ts        → src/workflow/truncate.ts       (121 lines, pure function)
STUDY  coordinate/supervisor.ts    → src/workflow/supervisor.ts     (stuck detection pattern)
STUDY  coordinate/dashboard.ts     → src/ui/dashboard.ts           (Phase 4)
STUDY  coordinate/render-utils.ts  → src/ui/render-utils.ts        (cherry-pick formatters)
STUDY  plan/interview.ts           → (inform SDD clarifier design)
```

### From pi-messenger

```
COPY   crew/utils/verdict.ts       → src/workflow/verdict.ts        (55 lines, direct copy)
ADAPT  crew/store.ts               → src/workflow/task-store.ts     (Phase 4 — task CRUD)
ADAPT  crew/task-actions.ts        → src/workflow/task-actions.ts   (Phase 4 — state transitions)
STUDY  crew/handlers/review.ts     → (inform reviewer agent prompt)
STUDY  crew/handlers/work.ts       → (inform Phase 4 parallel execution)
```

### From pi-planner

```
ADAPT  mode/hooks.ts               → src/workflow/tool-guard.ts     (tool restriction per role)
COPY   executor/stalled.ts         → src/workflow/stalled.ts        (34 lines, direct copy)
STUDY  index.ts                    → (inform approval gate pattern)
```

### From pi-manage-todo-list

```
ADAPT  ui/todo-widget.ts           → src/ui/progress-widget.ts     (widget rendering pattern)
```

---

## Architecture

```
src/
├── agents/              # UNTOUCHED — existing sub-agent system
│   ├── runner.ts        # runAgent() via createAgentSession()
│   ├── manager.ts       # createAgentManager() lifecycle
│   ├── registry.ts      # createRegistry() agent type configs
│   ├── defaults.ts      # built-in agent types
│   └── custom.ts        # user-defined agent types
│
├── workflow/            # NEW — orchestration layer (uses agents/ as engine)
│   ├── types.ts         # WorkflowPhase, WorkflowState, CostState, AgentHandoff, Verdict
│   ├── pipeline.ts      # Phase tracking, cost tracking, transitions
│   ├── router.ts        # Intent → workflow selection (LLM-driven)
│   ├── verdict.ts       # SHIP/NEEDS_WORK/MAJOR_RETHINK parsing
│   ├── agent-context.ts # Per-agent context persistence + handoff protocol
│   ├── recovery.ts      # Auto-continue on agent failure
│   ├── stalled.ts       # Timeout-based stall detection
│   ├── tool-guard.ts    # Tool restriction per agent role
│   ├── truncate.ts      # Output truncation (pure function)
│   ├── checkpoint.ts    # Workflow state persistence across crashes
│   └── progress.ts      # Progress document generation
│
├── workflows/           # NEW — workflow implementations (use workflow/ + agents/)
│   ├── research.ts      # W1: probe → report
│   ├── explore.ts       # W2: explore → summary
│   ├── fix.ts           # W3: scout → approve → build → review
│   ├── feature.ts       # W4: clarify → plan → test → build → review loop
│   └── task-store.ts    # Task CRUD with dependencies (W4 only)
│
├── ui/                  # EXISTING + additions
│   ├── widget.ts        # EXISTING (agent widget)
│   ├── viewer.ts        # EXISTING (conversation viewer)
│   ├── formatters.ts    # EXISTING
│   ├── progress-widget.ts # NEW: workflow phase + task progress widget
│   └── dashboard.ts     # NEW (Phase 4): /flow command
│
├── config/              # EXISTING
├── infra/               # EXISTING
├── extension/           # EXISTING
├── index.ts             # EXISTING — add workflow tool registration
└── types.ts             # EXISTING
```

---

## What We Explicitly Do NOT Take

| Feature | From | Why not |
|---------|------|---------|
| Subprocess runner (`pi --mode json`) | coordination | We use SDK (`createAgentSession`). The existing system works. |
| File reservations | messenger, coordination | Only needed for true parallel file edits. v1 builders run sequentially per task. |
| A2A messaging | coordination | Our agents communicate via handoff protocol, not messages. |
| Contracts (provide/need) | coordination | Only for multiple workers building shared interfaces. Not our model. |
| Full observability stack (7 JSONL files) | coordination | Overkill. v1: events in workflow state. |
| Worker lobby (pre-warming) | messenger | Optimization for later, after parallel execution is proven. |
| Subtasks (TASK-XX.Y) | coordination | Unnecessary complexity. Tasks are flat. |
| Plan mode safety registry (READ/WRITE per skill) | planner | We restrict tools per agent role. Simpler. |
| Markdown+YAML plan storage | planner | JSON workflow state is fine. |
| Full-screen dashboard (1524 lines) | coordination | v1 uses widget + `/flow` command. Full dashboard is Phase 4. |
| Async/detached mode | coordination | Workflows run in-session. |
