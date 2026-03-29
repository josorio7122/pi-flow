# Pi Extension Research — Repo Analysis

> Generated 2026-03-29. Analysis of 4 extensions to inform pi-flow v2 workflow features.

---

## 1. pi-manage-todo-list (tintinweb)

**Size:** 704 lines, 5 source files  
**Purpose:** Copilot-compatible `manage_todo_list` tool — structured todo tracking with live TUI widget.

### Architecture

```
src/
  types.ts          → TodoItem, TodoStatus, TodoStats, TodoDetails
  state-manager.ts  → TodoStateManager class (in-memory state + validation)
  tool.ts           → createManageTodoListTool() factory — read/write ops
  ui/todo-widget.ts → updateWidget() / clearWidget() — renders above editor
  index.ts          → Extension entry: wires state, tool, widget, /todos command
```

### How It Works

- **Single tool** with 2 operations: `read` (return list) and `write` (complete replacement — no partial updates)
- **Schema:** `{ id, title, description, status }` where status = `not-started | in-progress | completed`
- **State persistence:** Stores state in tool result `details` field. Reconstructs on session events (`session_start`, `session_switch`, `session_fork`, `session_tree`) by scanning session branch for `manage_todo_list` tool results
- **Widget:** Read-only display using `ctx.ui.setWidget()` — shows progress bar, status icons (✓ ◉ ○), themed colors
- **Commands:** `/todos` (show stats), `/todos clear` (reset)
- **LLM guidance:** Tool description includes CRITICAL workflow instructions: plan → mark in-progress → complete → mark completed → repeat. Warns on small lists (<3 items)

### Key Patterns

| Pattern | Implementation |
|---------|---------------|
| State management | Class with read/write/clear/validate methods |
| Persistence | Via tool `details` field — reconstructed from session history |
| Widget | Factory function passed to `ctx.ui.setWidget(id, renderFn)` |
| Tool registration | Factory function `createManageTodoListTool(state, onUpdate)` |
| Session events | `pi.on("session_start/switch/fork/tree")` → reconstruct state |
| Rendering | `renderCall` (shows operation type) + `renderResult` (expandable status breakdown) |

### Relevance to pi-flow

- **Direct integration candidate** — todo tracking is a natural workflow primitive
- **Widget pattern** is simple and reusable (setWidget with render function)
- **Persistence via details** is elegant but fragile (depends on tool results staying in branch)
- **State reconstruction from session history** — pattern we already use for memory

---

## 2. pi-planner (marcfargas)

**Size:** 5,311 lines, 11 source files + 16 test files  
**Purpose:** Persistent, auditable plan-then-execute workflow with human approval gates.

### Architecture

```
src/
  index.ts (768 lines!)    → Extension entry: plan_mode, plan_run_script tools, 
                              /plan /plans /safety commands, execution orchestration
  tools/
    index.ts                → plan_propose, plan_list, plan_get, plan_approve, plan_reject
    safety.ts               → plan_skill_safety tool (registers READ/WRITE classifications)
  mode/
    hooks.ts                → before_agent_start (context injection), tool_call (blocking/filtering)
  executor/
    runner.ts               → executePlan(), buildExecutorPrompt(), finishExecution()
    checkpoint.ts           → JSONL step-level checkpointing
    preflight.ts            → Pre-flight validation (tools exist, plan is approved)
    stalled.ts              → Stalled plan detection (timeout-based)
  persistence/
    plan-store.ts           → CRUD with atomic writes + optimistic locking, YAML frontmatter
    types.ts                → Plan, PlanStep, PlanScript, PlanStatus, PlannerConfig
    config.ts               → Reads .pi/plans.json
```

### How It Works

**Lifecycle:** `proposed → approved → executing → completed/failed/stalled`

1. **Plan Mode** — Agent calls `plan_mode(enable: true)`. Extension snapshots current tools, restricts to read-only set. `tool_call` hook enforces blocking.
2. **Propose** — Agent calls `plan_propose({ title, steps: [{ description, tool, operation, target }], context })`. Creates markdown file with YAML frontmatter in `.pi/plans/`.
3. **Approve** — Human approves via `/plans` TUI command or agent calls `plan_approve`. Triggers execution.
4. **Execute** — Executor prompt injected into tool result (same turn trick — avoids tool snapshot issue). Agent follows steps, reports via `plan_run_script({ action: "step_complete|step_failed|plan_complete|plan_failed" })`.
5. **Complete/Fail** — `finishExecution()` restores tools, updates plan status.

**Safety Registry** — Agent reads skill docs, calls `plan_skill_safety()` to register command patterns as READ or WRITE. Plan mode allows READ skill operations but blocks WRITE.

**Plan Storage** — Markdown files with YAML frontmatter. Optimistic locking (version field). Atomic writes via temp file + rename. In-memory cache with write-through.

### Key Patterns

| Pattern | Implementation |
|---------|---------------|
| Tool restriction | `pi.setActiveTools(filtered)` + `tool_call` hook enforcement |
| Context injection | `before_agent_start` returns `{ message: { customType, content, display: false } }` |
| Execution in-session | Executor prompt returned in `plan_approve` tool result (same-turn execution) |
| Persistence | Markdown + YAML frontmatter files, atomic writes, optimistic locking |
| State across sessions | `pi.appendEntry(type, data)` + session entries scan on restart |
| Safety classification | Glob patterns for bash commands, READ/WRITE levels |
| Step tracking | JSONL checkpoint files in `.pi/plans/sessions/` |
| Crash recovery | Stalled detection on session_start (plans stuck in executing past timeout) |
| Model switching | `ctx.modelRegistry.find(provider, modelId)` + `pi.setModel()` for executor |

### Relevance to pi-flow

- **Plan-then-execute is the core workflow pattern** we want. This is the most directly relevant repo.
- **Tool restriction via `setActiveTools` + `tool_call` hook** — dual layer (hide + enforce)
- **Executor prompt in tool result** — clever trick to avoid the tool snapshot issue
- **Optimistic locking for plans** — important for concurrent access
- **Safety registry** — could be generalized for any tool classification
- **Model switching per plan** — executor can run on different model than planner
- **State persistence via `appendEntry`** — cleaner than details-in-tool-result

---

## 3. pi-messenger (nicobailon)

**Size:** 21,698 lines, 42 source files + 30 test files  
**Purpose:** Agent-to-agent coordination mesh + "Crew" task orchestration system.

### Architecture — Two Systems

#### System 1: Messenger (Agent Mesh)
```
index.ts (1134 lines!)     → Extension entry: tool registration, event hooks, overlay management
lib.ts (433)                → MessengerState type, helpers (formatRelativeTime, generateAutoStatus)
store.ts (1125)             → File-based agent registry, inbox, reservations, feed
handlers.ts (990)           → Action implementations: join, list, send, reserve, release, etc.
feed.ts (227)               → Activity feed (JSONL in .pi/messenger/feed.jsonl)
config.ts (203)             → Config loading (project > user > defaults)
overlay.ts (797)            → MessengerOverlay — full chat TUI with tabs, input, scrolling
overlay-render.ts (652)     → Tab rendering (agents list, crew tasks, DM history, broadcast)
overlay-actions.ts (511)    → Overlay action handlers (send, claim, approve, etc.)
overlay-coordinator.ts (150)→ Overlay state management
config-overlay.ts (172)     → Config editing overlay
```

#### System 2: Crew (Task Orchestration)
```
crew/
  index.ts (239)            → Action router: plan, work, review, task.*, crew.*
  types.ts (174)            → CrewParams, task types
  store.ts (613)            → Plan/task CRUD, progress tracking, JSONL
  state.ts (20)             → Re-exports autonomous + planning state
  state-autonomous.ts (164) → Autonomous work state machine
  state-planning.ts (263)   → Planning state machine with cancel support
  spawn.ts (106)            → Worker spawning helpers
  lobby.ts (470)            → Worker lobby: pre-warmed idle workers for instant task assignment
  agents.ts (417)           → Agent process management, spawn pi --mode json subprocess
  prompt.ts (156)           → buildWorkerPrompt(): task + context + skills → system prompt
  registry.ts (114)         → Worker registry (track active workers per cwd)
  id-allocator.ts (30)      → Sequential task ID allocation
  live-progress.ts (58)     → Real-time worker progress via JSONL streaming
  task-actions.ts (123)     → Task state transitions (start, done, block, unblock, reset)
  handlers/
    plan.ts (819)           → Plan handler: spawn planner agent, parse output, create tasks
    work.ts (372)           → Work handler: spawn workers, autonomous mode, wave execution
    review.ts (298)         → Review handler: spawn reviewer agent, parse verdict
    revise.ts (374)         → Revise handler: parse structured feedback, apply task updates
    task.ts (645)           → Task CRUD handlers (list, show, start, done, block, etc.)
    status.ts (295)         → Crew status display, agent listing, install/uninstall
    coordination.ts (275)   → Worker coordination message handling
    sync.ts (232)           → Plan-sync handler: reconcile plan with code state
  utils/
    config.ts (156)         → Crew config loading + merging
    discover.ts (219)       → Skill discovery (user, extension, project directories)
    install.ts (85)         → Legacy agent cleanup migration
    progress.ts (120)       → Progress formatting helpers
    result.ts (16)          → Result builder helper
    truncate.ts (79)        → Output truncation
    verdict.ts (55)         → Review verdict parsing (SHIP, NEEDS_WORK, MAJOR_RETHINK)
    artifacts.ts (52)       → Artifact path management
```

### How It Works

**Messenger (coordination layer):**
- Agents join a mesh via file-based registry (`~/.pi/agent/messenger/`)
- Discovery via memorable themed names (SwiftRaven, LunarDust)
- File reservations enforced via `tool_call` hook (blocks write/edit on reserved paths)
- Messages delivered via inbox files, received via `pi.sendMessage({ triggerTurn: true, deliverAs: "steer" })`
- Activity tracking via `tool_call` + `tool_result` hooks → feed.jsonl
- Stuck detection: agents idle too long get flagged, peers notified
- `/messenger` overlay: full TUI with tabs (Agents, Crew, DMs, All), keyboard navigation

**Crew (task orchestration):**
1. **Plan** — Spawns planner agent (`pi --mode json` subprocess). Planner reads PRD, explores codebase, outputs task list. Optional reviewer pass (SHIP/NEEDS_WORK/MAJOR_RETHINK). Tasks stored as structured data.
2. **Work** — Spawns worker agents in parallel waves. Independent tasks run concurrently. Workers use messenger for coordination (join, reserve, send, release). Autonomous mode runs waves until all done/blocked.
3. **Review** — Spawns reviewer agent for each completed task. SHIP keeps it done, NEEDS_WORK resets for retry with feedback.
4. **Lobby** — Pre-warmed idle workers for instant task assignment (skip spawn overhead).
5. **Sync** — Reconcile plan with actual code state after work.

**Worker spawning:**
- `spawn("pi", ["--mode", "json", "--model", model, "-e", extension, "--print", prompt])` 
- JSONL output streaming for real-time progress
- Graceful shutdown: inbox message asking to stop → grace period → SIGTERM

### Key Patterns

| Pattern | Implementation |
|---------|---------------|
| File-based coordination | Registry, inbox, reservations all in `~/.pi/agent/messenger/` |
| Worker spawning | `child_process.spawn("pi", [...])` with `--mode json` |
| Lobby (pre-warming) | Idle workers waiting for tasks, reassigned via inbox message |
| Wave execution | Dependency graph → independent tasks in parallel |
| Review cycle | Reviewer verdict (SHIP/NEEDS_WORK/MAJOR_RETHINK) → retry or accept |
| Autonomous mode | After each wave, check for ready tasks → spawn next wave → repeat |
| Message delivery | Write to inbox file → `pi.sendMessage({ deliverAs: "steer" })` |
| File reservation enforcement | `tool_call` hook returns `{ block: true }` on reserved paths |
| Skill discovery | 3 sources: user `~/.pi/agent/skills/`, extension `crew/skills/`, project `.pi/messenger/crew/skills/` |
| Config layering | project → user → global settings → defaults |
| Activity tracking | `tool_call`/`tool_result` hooks → feed.jsonl |
| Overlay TUI | `ctx.ui.custom()` → Component with render/input/invalidate |

### Relevance to pi-flow

- **The Crew system is the closest to what we want** — PRD → plan → parallel execution → review
- **Wave-based execution with dependency graphs** — the core scheduling pattern
- **Pre-warmed lobby workers** — clever optimization, skip spawn overhead
- **File reservations** — critical for parallel workers modifying same codebase
- **Autonomous mode** — wave-after-wave until done, with configurable limits
- **Review cycles** — quality gate with structured feedback and retry
- **Skill discovery** — workers acquire domain knowledge on demand
- **Config layering** — project > user > defaults
- **Spawning via `pi --mode json`** — the subprocess approach vs pi-coordination's SDK approach

---

## 4. pi-coordination (nicobailon)

**Size:** 33,025 lines, 85 source files + tests  
**Purpose:** Full multi-agent coordination system with planning, parallel execution, contracts, review, observability, validation, and a real-time dashboard.

### Architecture

```
index.ts (325)              → Extension entry: registers coordinate, plan, coord_output tools + /jobs command
coordinator.ts (6)          → Coordinator-specific hooks (thin wrapper)
worker.ts (225)             → Worker hooks: self-review, enforce-json, file-reservation
planner.ts (6)              → Planner hooks (thin wrapper)
scout.ts (11)               → Scout hooks: bundle tools registration

plan/                       → Interactive planning pipeline
  index.ts (420)            → plan() tool entry: interview → scout → elaborate → structure → handoff
  interview.ts (672)        → Multi-round interview with 60s timeout per question
  scout-targeted.ts (475)   → Targeted codebase analysis, file map + context bundling
  elaborate.ts (293)        → Frontier model elaboration (no tools, pure LLM)
  structure.ts (307)        → Convert to TASK-XX format with validation
  handoff.ts (336)          → Show summary, offer execute/refine/exit

coordinate/                 → Execution runtime
  index.ts (1535)           → coordinate() tool: validation → pipeline → result
  pipeline.ts (817)         → Multi-phase orchestration (scout→planner→coordinator→workers→integration→review→fixes)
  dashboard.ts (1524)       → Full-screen /jobs TUI dashboard + MiniDashboard widget + MiniFooter
  state.ts (534)            → FileBasedStorage: tasks.json, state.json, cost.json, messages
  task-queue.ts (406)       → TaskQueueManager: priority-aware dispatch, dependency resolution
  deps.ts (442)             → Dependency graph: blocks, parent, waits-for, discovered
  subtasks.ts (374)         → TASK-XX.Y subtask creation, parent blocking/unblocking
  spec-parser.ts (428)      → Parse TASK-XX markdown format
  spec-validator.ts (414)   → Validate spec rules (no cycles, entry points exist, etc.)
  supervisor.ts (264)       → Stuck worker detection: nudge → restart → abandon
  nudge.ts (84)             → Nudge protocol (wrap_up, restart messages)
  auto-continue.ts (362)    → Smart restart: context.md analysis, continuation prompts
  worker-context.ts (654)   → Per-task context persistence (files modified, attempts, discoveries)
  coordinator-context.ts (790) → Session-level context management
  question-generator.ts (242) → LLM clarifying question generation
  inline-questions-tui.ts (554) → Sequential questions TUI
  async-runner.ts (160)     → Detached async coordination runner
  checkpoint.ts (102)       → Phase checkpointing
  log-generator.ts (324)    → Markdown coordination log generation
  progress.ts (208)         → Progress.md rendering
  render-utils.ts (694)     → TUI rendering helpers (tables, status bars, etc.)
  a2a.ts (242)              → Agent-to-agent messaging (typed messages with TTL)
  worker-control-registry.ts (43) → SDK worker abort/steer registry

  coordinator-tools/        → Tools available to the coordinator agent
    index.ts (1499)         → spawn_workers, spawn_from_queue, get_task_queue_status, 
                              assign_files, create_contract, broadcast, check_status, done
    sdk-tools.ts (589)      → SDK-specific tools (steer, abort workers)
    sdk-worker.ts (404)     → SDK worker wrapper

  worker-tools/             → Tools available to worker agents
    index.ts (927)          → agent_chat, agent_sync, agent_work, file_reservations (unified v2 API)

  phases/                   → Phase runners
    scout.ts (271)          → Scout phase: codebase analysis
    planner.ts (298)        → Planner phase: LLM generates task graph
    review.ts (188)         → Review phase: code reviewer checks changes
    integration.ts (219)    → Integration phase: cross-component review
    fix.ts (174)            → Fix phase: workers fix review issues

  observability/            → Full observability stack
    types.ts (294)          → Event types, span types, decision types
    events.ts (101)         → Enhanced event emitter with trace correlation
    spans.ts (78)           → Hierarchical timing spans
    decisions.ts (71)       → Decision audit trail
    causality.ts (66)       → Cause-effect relationship tracking
    errors.ts (72)          → Structured error logging
    resources.ts (101)      → Process/reservation lifecycle
    snapshots.ts (218)      → Git/file/coordination state snapshots
    llm.ts (39)             → LLM interaction logging
    index.ts (95)           → Observability factory

  validation/               → Post-hoc and streaming validation
    types.ts (89)           → Invariant types, validation results
    index.ts (7)            → Re-export
    loader.ts (191)         → Load coordination data from directory
    orchestrator.ts (145)   → Run all invariant checks
    streaming.ts (180)      → Real-time invariant checking
    report.ts (142)         → Validation report generation
    judge.ts (180)          → LLM-based quality judging
    content.ts (126)        → Content validation (files exist, have content)
    invariants/             → Individual invariant checkers
      session.ts, workers.ts, contracts.ts, costs.ts, reservations.ts,
      causality.ts, phases.ts, resources.ts

subagent/                   → Agent spawning runtime
  agents.ts (288)           → AgentConfig loading from .md files with frontmatter
  runner.ts (457)           → Subprocess runner: spawn pi --mode json, parse JSONL output
  sdk-runner.ts (672)       → In-process runner: createAgentSession() API
  render.ts (453)           → Output formatting and rendering
  truncate.ts (121)         → Output truncation
  artifacts.ts (45)         → Artifact path management
  types.ts (90)             → SingleResult, SubagentDetails, OnUpdateCallback

hooks/                      → Extension hooks
  enforce-json.ts (120)     → Force JSON output from coordinator/reviewer
  enforce-scout-format.ts (155) → Validate scout output format
  file-reservation.ts (185) → Block writes to reserved files
  fresh-eyes-review.ts (134)→ Worker self-review hook
  validate-spec-format.ts (273) → Validate TASK-XX spec format
```

### How It Works

**Two-Track Architecture:**

**Track 1: `plan` tool** (interactive → spec)
1. **Interview** — Multi-round questions with 60s timeout per question. LLM generates questions based on user's initial request. Sensible defaults if no answer.
2. **Scout** — Targeted codebase analysis. Builds file map, extracts relevant code sections. Produces contextDoc (~85K tokens) + metaPrompt (~15K tokens).
3. **Elaborate** — Frontier model creates detailed plan using context. No tools — pure LLM generation with ~100K token context.
4. **Structure** — Convert to TASK-XX format. Validates dependencies, file references, priority assignments.
5. **Handoff** — Show summary, offer: execute immediately, refine, or exit.

**Track 2: `coordinate` tool** (spec → execution)
1. **Validate** — Strict TASK-XX format validation (no cycles, entry points exist, valid refs)
2. **Coordinator Phase** — Coordinator agent manages the pipeline:
   - Spawns workers from task queue (priority-aware: P0-P3)
   - Workers claim tasks, execute, report completion
   - Supervisor monitors for stuck workers (nudge → restart → abandon)
   - Dynamic task pickup: new tasks from workers or reviewer spawn immediately
3. **Integration Phase** — Cross-component review (API contracts, shared types, data flow)
4. **Review Phase** — Code reviewer checks all changes against plan goals. Returns issues with file, line, severity.
5. **Fix Phase** — Same workers fix issues found in review. Repeat until clean or stuck.

**Two worker modes:**
- **Subprocess** (default): `spawn("pi", ["--mode", "json", ...])` — separate processes, JSONL output streaming
- **SDK** (opt-in): `createAgentSession()` — in-process, supports steer/abort via dashboard

**Worker tools (unified v2 API):**
- `agent_chat` — messages, broadcasts, escalations, inbox
- `agent_sync` — contract synchronization (provide/need interfaces)
- `agent_work` — task lifecycle (complete, step, add, deviation, plan)
- `file_reservations` — acquire, release, check

**Contracts** — Workers can define interfaces they provide and interfaces they need. Other workers wait until the provider signals the contract is ready. Prevents race conditions on shared types/APIs.

**Subtasks** — Workers can break TASK-XX into TASK-XX.Y subtasks. Parent blocks until all subtasks complete. Max 5 per parent.

**Discovered tasks** — Workers can call `agent_work({ action: "add" })` to create new tasks (DISC-XX). These need planner review before execution.

**Smart auto-continue** — When a worker fails, the system loads `context.md` from previous attempt, analyzes what was done, builds a continuation prompt: "Don't redo X, fix Y at line Z".

### Key Patterns

| Pattern | Implementation |
|---------|---------------|
| Task queue | Priority-based (P0-P3), dependency-aware dispatch |
| Worker spawning | Subprocess (`pi --mode json`) or SDK (`createAgentSession()`) |
| Contracts | Provide/need interface synchronization between workers |
| File reservations | Acquire/release with TTL, enforced via tool_call hook |
| Self-review | Before completion, worker reviews own changes with "fresh eyes" |
| A2A messaging | Typed messages (discovery, handoff, help_request) with read tracking + TTL |
| Observability | Events, spans, decisions, causality, errors, resources, snapshots — all JSONL |
| Validation | 9 invariant checkers + content validation + LLM-based quality judging |
| Dashboard | Full-screen TUI with worker list, task queue, events, cost breakdown |
| Cost control | Configurable limit with graceful shutdown |
| Supervisor | Inactivity detection → nudge → restart → abandon |
| Context persistence | Per-task context.md + attempt history, survives restarts |
| Phase pipeline | Sequential phases with checkpointing |
| Async mode | Detached runner, result file, event bus notification |
| Agent configs | Markdown files with YAML frontmatter (model, tools, system-prompt-mode) |

### Relevance to pi-flow

- **The most comprehensive system** — everything pi-flow could ever need is here
- **Task queue with priority + dependencies** — production-grade scheduling
- **Contracts** — unique feature, critical for parallel workers sharing interfaces
- **Two worker modes** (subprocess vs SDK) — flexibility we should offer
- **Observability stack** — full audit trail, essential for debugging multi-agent runs
- **Supervisor** — automated stuck detection and recovery
- **Auto-continue** — smart restarts with context from previous attempts
- **Validation** — invariant checking ensures correctness
- **Dashboard** — real-time monitoring is essential UX
- **Cost control** — budget limits with graceful shutdown

---

## Comparison Matrix

| Feature | todo-list | planner | messenger | coordination |
|---------|-----------|---------|-----------|--------------|
| **Core purpose** | Track tasks | Plan → approve → execute | Agent mesh + crew orchestration | Full multi-agent coordination |
| **Task model** | Flat list | Sequential steps | Dependency graph (waves) | Priority queue + dependency graph |
| **Parallel workers** | ✗ | ✗ (in-session) | ✓ (subprocess) | ✓ (subprocess + SDK) |
| **Human approval** | ✗ | ✓ (plan approve/reject) | ✗ | ✓ (interview, escalation) |
| **Review cycles** | ✗ | ✗ | ✓ (SHIP/NEEDS_WORK) | ✓ (code reviewer + fixes) |
| **File reservations** | ✗ | ✗ | ✓ | ✓ |
| **Agent messaging** | ✗ | ✗ | ✓ (DM + broadcast) | ✓ (A2A typed messages) |
| **Contracts** | ✗ | ✗ | ✗ | ✓ (provide/need) |
| **Tool restriction** | ✗ | ✓ (plan mode) | ✗ | ✗ |
| **Safety classification** | ✗ | ✓ (READ/WRITE) | ✗ | ✗ |
| **Observability** | ✗ | ✗ | Activity feed | Full stack (events, spans, etc.) |
| **Dashboard** | Widget | Widget | Overlay TUI | Full-screen TUI |
| **Cost control** | ✗ | ✗ | ✗ | ✓ (budget limit) |
| **Persistence** | Tool details | Markdown + YAML | Files + JSONL | Files + JSONL |
| **Lines of code** | 704 | 5,311 | 21,698 | 33,025 |

## Key Takeaways for pi-flow v2

### Must-Have (from all repos)

1. **Todo/task tracking** (from todo-list) — simple structured state the LLM manages
2. **Plan-then-execute pattern** (from planner) — propose → approve → execute
3. **Parallel worker spawning** (from messenger + coordination) — subprocess or SDK
4. **Dependency graph scheduling** (from messenger + coordination) — wave-based execution
5. **File reservations** (from messenger + coordination) — prevent parallel conflicts
6. **Review cycles** (from messenger + coordination) — quality gate with retry
7. **Widget + status** (from all) — real-time progress visibility

### Should-Have

8. **Tool restriction** (from planner) — plan mode blocks destructive tools
9. **Contracts** (from coordination) — provide/need interface sync
10. **Supervisor** (from coordination) — stuck detection + auto-recovery
11. **Cost control** (from coordination) — budget limits
12. **Smart auto-continue** (from coordination) — restart with context
13. **A2A messaging** (from coordination) — typed inter-worker communication
14. **Dashboard** (from coordination) — full monitoring TUI

### Architecture Decisions

| Decision | Recommendation | Rationale |
|----------|---------------|-----------|
| Worker spawning | Support both subprocess + SDK | Subprocess for isolation, SDK for speed |
| Task storage | JSONL + structured files | All 3 multi-agent systems use this |
| Scheduling | Priority queue + dependency graph | coordination's TaskQueueManager is the gold standard |
| State persistence | `pi.appendEntry()` + files | Cleaner than details-in-tool-result |
| Config | Project > user > defaults layering | All repos do this |
| Agent configs | Markdown + YAML frontmatter | Already in pi-flow from pi-subagents |
| Observability | Events + decisions JSONL minimum | coordination's full stack is overkill initially |
| Review | SHIP/NEEDS_WORK/MAJOR_RETHINK verdict | messenger's model is simpler than coordination's |
