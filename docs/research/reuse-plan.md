# pi-flow v2 Reuse Plan

> What to take from each repo, how to adapt it, and what to build new.

---

## pi-flow Vision Recap

pi-flow is an **intelligent workflow engine** — the LLM orchestrator observes user intent, selects the right workflow, spawns specialized agents, manages their lifecycle, shares context between them, and gives the user full visibility + approval gates.

### Workflows

| ID | Intent | Phases | Agents |
|----|--------|--------|--------|
| W1 | Simple fix | Scout → Report → Approve → Build → Review → Report | scout, builder, reviewer |
| W2 | Research/verify | Probe → Report | probe |
| W3 | Complex feature | Clarify (SDD) → Plan → Test (red) → Build (green) → Review loop → Report | clarifier, planner, test-writer, builder, reviewer |
| W4 | Understand code | Explore → Summary → User decides next | explorer |

### Agent Roles

| Role | What it does | Tools |
|------|-------------|-------|
| **Scout** | Reads codebase, finds relevant code, produces analysis | read, grep, find, ls, bash (read-only) |
| **Probe** | Research/verification — DB queries, web search, docker | bash, exa, docker tools |
| **Clarifier** | Asks user questions, builds SDD (Spec-Driven Design) | read, bash (read-only), user questions |
| **Planner** | Creates structured plan from understanding | read, bash (read-only) |
| **Test-writer** | Writes failing tests from spec (red phase) | read, write, edit, bash |
| **Builder** | Implements code to make tests pass (green phase) | read, write, edit, bash |
| **Reviewer** | Checks work against spec+plan, produces verdict | read, grep, find, bash (read-only) |
| **Explorer** | Deep-reads codebase, produces understanding report | read, grep, find, ls, bash (read-only) |

### System Requirements

1. **Smart routing** — orchestrator LLM decides workflow, not hardcoded
2. **Context sharing** — agent outputs feed into next agent's prompt
3. **Resilience** — failure recovery, auto-continue with context
4. **Visibility** — dashboard, progress, active agents, what each is doing
5. **Human-in-the-loop** — approve plans, review results, decide commits
6. **Cost awareness** — track token usage, budget limits

---

## Reuse Analysis

### Layer 1: Agent Spawning & Lifecycle (Already Have + Adapt)

**What we have in pi-flow today:**
- `createAgentSession()` (SDK mode) in `agents/runner.ts`
- `createAgentManager()` in `agents/manager.ts`
- `createRegistry()` for agent type configs in `agents/registry.ts`
- Agent configs from markdown frontmatter in `agents/defaults.ts` + `agents/custom.ts`

**What to take:**

| Source | What | Why | Adaptation |
|--------|------|-----|------------|
| **pi-coordination** `subagent/runner.ts` | `runSingleAgent()` — subprocess mode (`pi --mode json`) | Need subprocess mode for parallel workers (SDK is single-threaded) | Extract the JSONL output parsing, progress tracking, and temp file prompt handling. We already have SDK mode — this adds subprocess as alternative. |
| **pi-coordination** `subagent/types.ts` | `SingleResult`, `OnUpdateCallback`, `OutputLimits` | Clean result type for agent runs | Copy types, adapt to our `types.ts` conventions |
| **pi-coordination** `subagent/truncate.ts` | `truncateOutputHead()` | Output truncation for agent results | Direct copy, it's a pure function (121 lines) |
| **pi-messenger** `crew/agents.ts` | `spawnAgents()`, `resolveModel()` | Process spawning with model resolution | Already have `resolveModel` — take the subprocess spawn pattern |

**Build new:**
- Unified `SpawnMode` type: `"sdk" | "subprocess"` — let workflow decide
- `runAgent()` wrapper that delegates to SDK or subprocess based on mode

---

### Layer 2: Workflow Pipeline (Take from pi-coordination)

**What to take:**

| Source | What | Why | Adaptation |
|--------|------|-----|------------|
| **pi-coordination** `coordinate/pipeline.ts` | `PipelineConfig`, `PipelineContext`, `PipelineResult`, phase status tracking, cost tracking, review-fix loop | **This is the core of what we need.** Phase pipeline with status, cost, checkpointing, stuck detection. | Heavy adaptation — strip the observability noise, keep: phase tracking, cost tracking, review-fix loop, stuck detection. Our pipelines are different (W1-W4) but the pipeline *machinery* is the same. |
| **pi-coordination** `coordinate/types.ts` | `PipelinePhase`, `PipelineState`, `PhaseResult`, `CostState`, `Task`, `TaskStatus` | Type foundations for pipeline + task tracking | Adapt phase names to ours (scout, plan, test, build, review). Keep `CostState` as-is. Simplify `Task` — we don't need priority queue initially. |
| **pi-coordination** `coordinate/checkpoint.ts` | `CheckpointManager` | Save/restore pipeline state across crashes | Direct reuse (102 lines, simple) |
| **pi-coordination** `coordinate/progress.ts` | `generateProgressDoc()` | Progress.md generation for visibility | Adapt to our phase names |

**Key insight:** pi-coordination's `runReviewFixLoop()` is exactly what W1 and W3 need — review → detect issues → fix → re-review → until clean or stuck. Copy this pattern directly.

---

### Layer 3: Task Management (Take from pi-messenger, simpler)

pi-coordination's `TaskQueueManager` is 406 lines with file locking, subtasks, discovered tasks, priority queues — overkill for v1. pi-messenger's crew store is simpler and closer to what we need.

| Source | What | Why | Adaptation |
|--------|------|-----|------------|
| **pi-messenger** `crew/store.ts` | Task CRUD, plan storage, progress tracking | Simpler than coordination's. Tasks are `{ id, title, description, status, dependencies, files }`. JSONL progress per task. | Strip messenger-specific fields (assigned_to, base_commit, lobby). Keep: create, update, getReadyTasks, dependency resolution. |
| **pi-messenger** `crew/task-actions.ts` | `startTask`, `completeTask`, `blockTask`, `resetTask` | Clean state transitions | Direct copy, adapt types |
| **pi-messenger** `crew/store.ts` → `getReadyTasks()` | Dependency-aware task readiness | Tasks whose deps are all complete become ready | Direct copy (it's a filter + dependency check) |
| **pi-manage-todo-list** `state-manager.ts` | `TodoStateManager` validation pattern | For simple task tracking (W1, W2) | Use as inspiration for lightweight task tracking when full plan isn't needed |

---

### Layer 4: Context Sharing Between Agents (Take from pi-coordination)

This is critical — agents must not start from scratch. The scout's output feeds the planner, the planner's output feeds the test-writer, etc.

| Source | What | Why | Adaptation |
|--------|------|-----|------------|
| **pi-coordination** `coordinate/worker-context.ts` | `WorkerContext`, `loadContext()`, `saveContext()`, `updateContext()` | Per-task context persistence that survives agent restarts. Tracks: files modified, discoveries, attempt history. | Generalize from "worker" to "agent" context. Keep: context.md pattern, attempt tracking. Add: previous agent's output as context for next agent. |
| **pi-coordination** `coordinate/auto-continue.ts` | `processWorkerExit()`, continuation prompt building | When agent fails, build a smart restart prompt: "Don't redo X, fix Y at line Z" | Direct reuse concept. Our agents fail too — the auto-continue pattern is universally useful. |
| **pi-coordination** `coordinate/coordinator-context.ts` | Session-level context (not per-task) | The orchestrator needs session context too — what's been done, what's pending | Simplify heavily (790 lines is too much). Take the concept: `WorkflowContext` that tracks overall progress. |

**Build new:**
- `AgentHandoff` type: structured output from one agent that becomes input for the next
- `buildAgentPrompt(role, task, previousContext, plan)` — assembles prompt from workflow state

---

### Layer 5: Review System (Take from pi-messenger, simpler verdict model)

| Source | What | Why | Adaptation |
|--------|------|-----|------------|
| **pi-messenger** `crew/utils/verdict.ts` | `parseVerdict()` → SHIP / NEEDS_WORK / MAJOR_RETHINK | Simple, clear verdicts. 55 lines. | Direct copy. This is the review output format we want. |
| **pi-messenger** `crew/handlers/review.ts` | `reviewImplementation()` — spawns reviewer with git diff context | Review pattern: get diff → build prompt → spawn reviewer → parse verdict | Adapt: use our agent spawning, but keep the diff-based review approach |
| **pi-coordination** `coordinate/phases/review.ts` | `runReviewPhase()` — structured review with file/line/severity issues | More structured than messenger's. Returns `ReviewIssue[]` with file, line, description, severity. | Take the `ReviewIssue` type and structured output parsing. Combine with messenger's simpler verdict. |
| **pi-coordination** pipeline's `detectStuckIssues()` | Detect when same issues keep appearing across review cycles | Prevents infinite review-fix loops | Direct copy (15 lines, pure function) |

**Our review model:**
```
Verdict: SHIP | NEEDS_WORK | MAJOR_RETHINK
Issues: [{ file, line?, description, severity }]
Summary: string
```
- SHIP → workflow complete, report to user
- NEEDS_WORK → feed issues to builder, re-review (max N cycles)
- MAJOR_RETHINK → escalate to user, plan may need revision

---

### Layer 6: Visibility & Dashboard (Take from pi-coordination + pi-manage-todo-list)

| Source | What | Why | Adaptation |
|--------|------|-----|------------|
| **pi-manage-todo-list** `ui/todo-widget.ts` | `updateWidget()` — simple progress widget | Clean pattern: render lines with status icons, call `ctx.ui.setWidget()` | Direct pattern reuse for workflow progress widget |
| **pi-coordination** `coordinate/progress.ts` | `generateProgressDoc()` — progress.md generation | Structured progress document | Adapt to our phases |
| **pi-coordination** `coordinate/dashboard.ts` | `CoordinationDashboard`, `MiniDashboard`, `MiniFooter` | Full-screen dashboard via `ctx.ui.custom()` + compact footer widget | Study the interaction patterns. For v1, start with widget + footer (not full dashboard). Dashboard is v2. |
| **pi-coordination** `coordinate/render-utils.ts` | Table rendering, status bars, phase timeline | TUI formatting helpers | Cherry-pick what we need — `formatDuration`, `renderPhaseTimeline`, status icons |
| **pi-messenger** `crew/live-progress.ts` | Real-time worker progress via JSONL streaming | Shows each worker's current tool, call count, token usage | Adapt for our parallel agent tracking |

**Our visibility model (v1):**
1. **Widget** (always visible): Phase pipeline + active agents + task progress
2. **Status bar**: `[flow] scout ● 2/5 tasks | $0.45 | 2m30s`
3. **`/flow` command**: Show detailed progress, allow intervention

---

### Layer 7: Human-in-the-Loop (Take from pi-planner)

| Source | What | Why | Adaptation |
|--------|------|-----|------------|
| **pi-planner** `mode/hooks.ts` | Tool restriction in plan mode (`setActiveTools` + `tool_call` hook) | During planning/review, agents shouldn't modify files | Direct pattern reuse — restrict tools per phase |
| **pi-planner** `index.ts` → execution flow | Approval gates: user approves plan before execution starts | Human approval is core to pi-flow | Adapt: our approval points are after plan creation and after review |
| **pi-planner** `persistence/plan-store.ts` | Plan storage with optimistic locking | Plans need to survive crashes | Simplify — we don't need the full markdown+YAML format. JSON is fine for v1. |
| **pi-coordination** `coordinate/inline-questions-tui.ts` | Sequential questions TUI with timeout | For the Clarifier agent (SDD workflow) — asks user questions interactively | Study the pattern. We need: ask question → wait for answer → ask next. Could use `ctx.ui.editor()` or custom TUI. |

---

### Layer 8: Resilience & Recovery (Take from pi-coordination)

| Source | What | Why | Adaptation |
|--------|------|-----|------------|
| **pi-coordination** `coordinate/supervisor.ts` | `SupervisorLoop` — nudge → restart → abandon | Agents can get stuck. Need automated detection + recovery. | Simplify: we don't need the full class. Take the pattern: check activity timestamp → if stale → nudge via steer → if still stale → restart. |
| **pi-coordination** `coordinate/auto-continue.ts` | `processWorkerExit()` — smart restart with context | When builder fails, restart with "here's what was done, fix this" | Direct concept reuse. Adapt to our `AgentHandoff` type. |
| **pi-planner** `executor/stalled.ts` | Stalled detection (timeout-based) | Detect agents stuck in executing state | Direct copy (34 lines) |

---

## What to Build New (Not in Any Repo)

| Component | Why it's new | Description |
|-----------|-------------|-------------|
| **Workflow Router** | No repo has an LLM-based intent classifier | The orchestrator tool that analyzes user intent and selects W1-W4. Uses the LLM itself — not a hardcoded switch. The tool description guides the LLM on when to use which workflow. |
| **SDD Clarifier** | No repo does spec-driven design | Interactive clarification phase: ask questions until the spec is complete. Different from pi-coordination's interview (which is planning-focused). This is requirements gathering. |
| **Test-Writer Agent** | No repo has TDD as a first-class phase | Agent that reads the plan and writes failing tests. Must run tests to confirm red. This is unique to pi-flow's TDD philosophy. |
| **Red-Green Verification** | No repo verifies test state transitions | After test-writer (red) and builder (green), verify that tests actually transitioned from failing to passing. Not just "tests pass" — they must have been red first. |
| **Agent Handoff Protocol** | All repos use ad-hoc context passing | Structured `AgentHandoff` type: `{ role, task, output, filesModified, context, nextAgent }`. Each agent produces a handoff that becomes the next agent's input. |
| **Workflow State Machine** | Repos use either linear pipelines or task graphs | We need a hybrid: the workflow is a state machine (phase transitions), but within a phase there can be parallel tasks. |

---

## Implementation Priority

### Phase 1: Foundation (reuse-heavy)

| # | Component | Source | LOC estimate |
|---|-----------|--------|-------------|
| 1 | Agent handoff types | New | ~80 |
| 2 | Workflow types (phases, state, cost) | pi-coordination types.ts | ~120 |
| 3 | Subprocess runner | pi-coordination subagent/runner.ts | ~200 (stripped) |
| 4 | Output truncation | pi-coordination subagent/truncate.ts | ~120 (direct copy) |
| 5 | Pipeline engine (phase tracking, cost, checkpointing) | pi-coordination pipeline.ts | ~250 (stripped) |
| 6 | Review-fix loop | pi-coordination pipeline.ts `runReviewFixLoop` | ~80 |
| 7 | Verdict parsing | pi-messenger verdict.ts | ~55 (direct copy) |
| 8 | Progress widget | pi-manage-todo-list widget.ts | ~80 |
| 9 | Stuck detection | pi-coordination supervisor.ts (pattern) | ~60 |
| 10 | Agent context persistence | pi-coordination worker-context.ts (simplified) | ~150 |

**Total Phase 1: ~1,200 lines of new/adapted code**

### Phase 2: Workflows

| # | Component | Source | LOC estimate |
|---|-----------|--------|-------------|
| 11 | W1: Simple fix workflow (scout → build → review) | New + pi-coordination phases | ~200 |
| 12 | W2: Research/verify workflow (probe) | New | ~100 |
| 13 | W4: Understand workflow (explorer) | New | ~100 |
| 14 | Workflow router tool | New | ~150 |
| 15 | Agent role configs (.md files) | pi-coordination agents/*.md | ~300 (8 agent configs) |
| 16 | Task store (simple) | pi-messenger crew/store.ts | ~200 (stripped) |

**Total Phase 2: ~1,050 lines**

### Phase 3: Complex Workflows + Polish

| # | Component | Source | LOC estimate |
|---|-----------|--------|-------------|
| 17 | W3: Complex feature workflow (SDD → plan → TDD → build → review) | New | ~300 |
| 18 | SDD clarifier | New + pi-coordination interview.ts (pattern) | ~200 |
| 19 | Test-writer agent + red-green verification | New | ~200 |
| 20 | Auto-continue (smart restart) | pi-coordination auto-continue.ts | ~150 |
| 21 | Dashboard (`/flow` command) | pi-coordination dashboard.ts (simplified) | ~300 |
| 22 | Parallel execution (multiple builders) | pi-messenger crew/spawn.ts | ~150 |
| 23 | Cost control | pi-coordination pipeline.ts | ~50 |

**Total Phase 3: ~1,350 lines**

---

## File-Level Reuse Map

Concrete files to copy/adapt from each repo:

### From pi-coordination (most reuse)

```
COPY   subagent/truncate.ts        → src/workflow/truncate.ts       (121 lines, pure function)
ADAPT  subagent/runner.ts          → src/agents/subprocess.ts       (take JSONL parsing, temp file prompt)
ADAPT  subagent/types.ts           → src/workflow/types.ts          (SingleResult → AgentResult)
ADAPT  coordinate/types.ts         → src/workflow/types.ts          (PipelinePhase, CostState, Task)
ADAPT  coordinate/pipeline.ts      → src/workflow/pipeline.ts       (phase tracking, cost, review-fix loop)
ADAPT  coordinate/checkpoint.ts    → src/workflow/checkpoint.ts     (102 lines, simplify)
ADAPT  coordinate/progress.ts      → src/workflow/progress.ts       (adapt phase names)
ADAPT  coordinate/worker-context.ts→ src/workflow/agent-context.ts  (generalize to any agent role)
ADAPT  coordinate/auto-continue.ts → src/workflow/recovery.ts       (smart restart logic)
ADAPT  coordinate/supervisor.ts    → src/workflow/supervisor.ts     (stuck detection pattern only)
STUDY  coordinate/dashboard.ts     → src/ui/dashboard.ts           (v2 — study TUI patterns)
STUDY  coordinate/render-utils.ts  → src/ui/render-utils.ts        (cherry-pick formatters)
STUDY  plan/interview.ts           → (inform SDD clarifier design)
```

### From pi-messenger (simpler patterns)

```
COPY   crew/utils/verdict.ts       → src/workflow/verdict.ts        (55 lines, direct copy)
ADAPT  crew/store.ts               → src/workflow/task-store.ts     (task CRUD, stripped)
ADAPT  crew/task-actions.ts        → src/workflow/task-actions.ts   (state transitions)
ADAPT  crew/handlers/review.ts     → (inform review agent prompt)
STUDY  crew/handlers/work.ts       → (inform wave execution)
STUDY  crew/spawn.ts               → (inform parallel spawning)
STUDY  crew/lobby.ts               → (v2 — pre-warmed workers)
```

### From pi-planner (approval + tool restriction)

```
ADAPT  mode/hooks.ts               → src/workflow/tool-guard.ts     (tool restriction per phase)
STUDY  executor/runner.ts          → (executor prompt injection trick)
COPY   executor/stalled.ts         → src/workflow/stalled.ts        (34 lines, direct copy)
STUDY  persistence/plan-store.ts   → (inform plan storage design)
```

### From pi-manage-todo-list (widget pattern)

```
ADAPT  ui/todo-widget.ts           → src/ui/progress-widget.ts     (widget rendering pattern)
STUDY  state-manager.ts            → (inform lightweight state)
```

---

## Architecture Summary

```
src/
├── agents/              # EXISTING — agent spawning (SDK + subprocess)
│   ├── runner.ts        # SDK mode (existing)
│   ├── subprocess.ts    # NEW: subprocess mode (from pi-coordination)
│   ├── manager.ts       # EXISTING — agent lifecycle
│   ├── registry.ts      # EXISTING — agent type configs
│   └── ...
│
├── workflow/            # NEW — workflow engine
│   ├── types.ts         # Phase, CostState, Task, AgentHandoff, Verdict
│   ├── pipeline.ts      # Phase tracking, cost, checkpointing
│   ├── router.ts        # Intent → workflow selection (LLM-driven)
│   ├── task-store.ts    # Task CRUD with dependency resolution
│   ├── task-actions.ts  # State transitions
│   ├── verdict.ts       # SHIP/NEEDS_WORK/MAJOR_RETHINK parsing
│   ├── agent-context.ts # Per-agent context persistence + handoff
│   ├── recovery.ts      # Auto-continue on failure
│   ├── stalled.ts       # Timeout-based stall detection
│   ├── tool-guard.ts    # Tool restriction per phase
│   ├── truncate.ts      # Output truncation
│   ├── checkpoint.ts    # Pipeline state persistence
│   └── progress.ts      # Progress document generation
│
├── workflows/           # NEW — workflow implementations
│   ├── simple-fix.ts    # W1: scout → build → review
│   ├── research.ts      # W2: probe → report
│   ├── feature.ts       # W3: clarify → plan → test → build → review
│   └── explore.ts       # W4: explore → report
│
├── ui/                  # EXISTING + NEW
│   ├── widget.ts        # EXISTING
│   ├── viewer.ts        # EXISTING
│   ├── formatters.ts    # EXISTING
│   ├── progress-widget.ts # NEW: workflow progress widget
│   └── dashboard.ts     # NEW (v2): full-screen /flow dashboard
│
├── config/              # EXISTING
├── infra/               # EXISTING
├── extension/           # EXISTING
├── index.ts             # EXISTING — wire workflow tools
└── types.ts             # EXISTING
```

---

## What We Explicitly Do NOT Take

| Feature | From | Why not |
|---------|------|---------|
| File reservations | messenger, coordination | Only needed for true parallel file edits. v1 runs one builder at a time. |
| A2A messaging | coordination | Our agents communicate via handoff, not messages. |
| Contracts (provide/need) | coordination | Only needed when multiple workers build shared interfaces. v1 is sequential. |
| Full observability stack | coordination | 7 JSONL files is overkill. v1: single events.jsonl. |
| Worker lobby (pre-warming) | messenger | Optimization for v2 when parallel execution is proven. |
| Subtasks (TASK-XX.Y) | coordination | Complexity we don't need in v1. Tasks are flat. |
| Plan mode safety registry | planner | We restrict tools per phase, not per skill classification. Simpler. |
| Markdown+YAML plan storage | planner | JSON is fine for v1. No need for human-readable plan files yet. |
| Full dashboard | coordination | 1524 lines. v1 uses widget + footer. Dashboard is v2. |
| Async mode | coordination | v1 workflows run in-session. Async is v2. |
