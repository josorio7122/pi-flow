# Workflow Tooling — The Foundation Layer

> Everything that must work before ANY workflow (W1-W4) can run.
> This is the plan we build first. If this fails, everything fails.

---

## What Is "Workflow Tooling"

The shared infrastructure that every workflow uses:

| Concern | What it does | Used by |
|---------|-------------|---------|
| **State store** | Read/write/update workflow state on disk | All workflows |
| **Event log** | Append events, read timeline | All workflows |
| **Handoff I/O** | Write agent output, read it for next agent | W2, W3, W4 |
| **Recovery** | Detect active workflow on session_start, resume | All workflows |
| **Phase engine** | Track phase transitions, timing, cost | All workflows |
| **Review loop** | Review → verdict → fix → re-review cycle | W3, W4 |
| **Verdict parsing** | Parse SHIP/NEEDS_WORK/MAJOR_RETHINK from reviewer output | W3, W4 |
| **Progress widget** | Show workflow status in TUI | All workflows |
| **Stalled detection** | Detect agents stuck past timeout | All workflows |
| **Tool restriction** | Block write/edit for read-only agent roles | W2, W3, W4 |

---

## File Format Decisions

| File | Format | Why |
|------|--------|-----|
| `state.json` | **JSON** | Machine-readable, schema-validatable, mutable (read-modify-write). Markdown would need parsing — unnecessary complexity for state that's never read by humans in-flow. |
| `events.jsonl` | **JSONL** | Append-only (no read-modify-write, crash-safe). One event per line — can parse incrementally. Both pi-coordination and pi-messenger use JSONL for event logs. Proven pattern. |
| `handoffs/*.json` | **JSON** | Structured data the orchestrator needs to read specific fields from (`summary`, `verdict`, `issues`). Markdown would require regex parsing for structured fields — fragile. |
| `tasks/*.json` | **JSON** (W4 only) | Individual files per task (pi-messenger pattern) — atomic per-task updates, no lock contention. Single `tasks.json` (pi-coordination pattern) risks corruption on concurrent writes. |

**Why not markdown anywhere?** Markdown is for humans. Our consumers are: (1) the orchestrator LLM reading handoffs, (2) the pipeline engine reading state, (3) the widget reading progress. All need structured access to specific fields. JSON gives that without parsing overhead. The event log + handoffs ARE the human-readable audit trail when formatted.

---

## Directory Structure

```
.pi/flow/
└── <workflow-id>/          # e.g. "flow-a1b2c3d4"
    ├── state.json          # WorkflowState — the main snapshot
    ├── events.jsonl        # Append-only event timeline
    ├── handoffs/           # Agent output files (numbered for ordering)
    │   ├── 001-scout.json
    │   ├── 002-builder.json
    │   └── 003-reviewer.json
    └── tasks/              # W4 only — task graph
        ├── task-1.json
        └── task-2.json
```

---

## Component Breakdown

### 1. `src/workflow/store.ts` — File I/O Primitives

**Source: pi-messenger `crew/store.ts` lines 17-78**

Copy the 4 I/O helpers (atomic JSON write, safe read) plus `ensureDir`. These are the building blocks everything else uses.

```
COPY from pi-messenger crew/store.ts:
  ensureDir()     — mkdir -p helper
  readJson<T>()   — safe JSON read, returns null on missing/corrupt
  writeJson()     — atomic write via temp + rename
  readText()      — safe text read
  writeText()     — atomic text write
```

**Then build on top — workflow-specific operations:**

```ts
// Workflow directory management
function getFlowDir(cwd: string, workflowId: string): string
function getHandoffsDir(cwd: string, workflowId: string): string
function getTasksDir(cwd: string, workflowId: string): string
function initWorkflowDir(cwd: string, workflowId: string): void

// State operations
function readState(cwd: string, workflowId: string): WorkflowState | null
function writeState(cwd: string, workflowId: string, state: WorkflowState): void
function updateState(cwd: string, workflowId: string, updater: (s: WorkflowState) => void): void

// Handoff operations
function writeHandoff(cwd: string, workflowId: string, handoff: AgentHandoff): string  // returns filename
function readHandoff(cwd: string, workflowId: string, filename: string): AgentHandoff | null
function listHandoffs(cwd: string, workflowId: string): AgentHandoff[]

// Event operations  
function appendEvent(cwd: string, workflowId: string, event: WorkflowEvent): void
function readEvents(cwd: string, workflowId: string): WorkflowEvent[]
```

**Why sync I/O (like pi-messenger) instead of async (like pi-coordination)?**
Our workflows run in the orchestrator's turn — there's no concurrent file access from multiple processes. Sync is simpler, no race conditions, no locks needed. pi-coordination needs async + locks because it has parallel subprocess workers writing to the same directory. We don't — our agents run via SDK (`createAgentSession`) in the same process, and the orchestrator is the only writer.

**Estimated: ~120 lines** (36 copied helpers + ~84 new workflow operations)

---

### 2. `src/workflow/types.ts` — Type Definitions

**Sources + decisions:**

| Type | Source | Format |
|------|--------|--------|
| `WorkflowType` | NEW | `"research" \| "explore" \| "fix" \| "feature"` |
| `WorkflowPhase` | ADAPT from pi-coordination `PipelinePhase` | Our phases: `"probe" \| "explore" \| "scout" \| "clarify" \| "plan" \| "test" \| "build" \| "review" \| "complete" \| "failed"` |
| `AgentRole` | NEW | `"probe" \| "explorer" \| "scout" \| "clarifier" \| "planner" \| "test-writer" \| "builder" \| "reviewer"` |
| `PhaseResult` | COPY from pi-coordination (L164-172) | `{ phase, status, startedAt?, completedAt?, error?, attempt }` |
| `ExitReason` | COPY from pi-coordination (L173) | `"clean" \| "stuck" \| "max_cycles" \| "cost_limit" \| "user_abort"` |
| `WorkflowState` | ADAPT from pi-coordination `PipelineState` | See state.json schema below |
| `CostState` | ADAPT from pi-coordination (L231-238) | `{ total, byPhase, limit, limitReached }` — drop `byWorker` |
| `AgentHandoff` | NEW | See handoff schema below |
| `ReviewVerdict` | COPY from pi-messenger `crew/types.ts` (L145) | `"SHIP" \| "NEEDS_WORK" \| "MAJOR_RETHINK"` |
| `ReviewIssue` | COPY from pi-coordination (L195-206) | `{ id, file, line?, severity, category, description, suggestedFix? }` — drop `originalWorker`, `fixAttempts` |
| `WorkflowEvent` | NEW (informed by pi-coordination `CoordinationEvent` + pi-messenger `FeedEvent`) | Discriminated union — see event schema below |
| `ActiveAgent` | NEW | `{ agentId, role, phase, startedAt }` |
| `CompletedAgent` | NEW | `{ agentId, role, phase, handoffFile, duration, exitStatus, error? }` |

**Estimated: ~130 lines**

---

### 3. `src/workflow/pipeline.ts` — Phase Engine

**Source: pi-coordination `coordinate/pipeline.ts`**

| Function | Source | What it does | Changes |
|----------|--------|-------------|---------|
| `createWorkflowState()` | ADAPT `initializePipelineState` (L75-101) | Initialize state for a workflow type. Maps `WorkflowType` → list of phases. | New phase mapping logic. Drop `planPath`/`planHash`. |
| `createCostState()` | ADAPT `initializeCostState` (L103-120) | Initialize cost tracking. | Change `byPhase` key type. |
| `updatePhaseStatus()` | ADAPT (L122-173) | Transition a phase: pending→running→complete/failed. Track timing. | Replace `ctx.obs` calls with `onEvent` callback that routes to `appendEvent`/`events.jsonl`. Same instrumentation points, simpler backend. |
| `checkCostLimit()` | ADAPT (L193-209) | Check if cost exceeds limit. Returns boolean. | Replace `ctx.obs` with `onEvent` callback. Emit token limit event. |
| `detectStuckIssues()` | COPY (L211-229) | Detect repeated issues across review cycles. Returns boolean. | Zero changes — pure function operating on `ReviewIssue[]`. |

**NOT taking the phase wrapper functions** (`runScoutPhaseWrapper`, etc.) — those are tied to pi-coordination's spawning model. Our workflows call `runAgent()` directly.

**The review-fix loop** — this is the critical piece:

```ts
// ADAPT from pi-coordination pipeline.ts L757-817
// Extracted as a standalone function that takes callbacks
function runReviewFixLoop(params: {
  state: WorkflowState
  maxCycles: number
  sameIssueLimit: number
  costState: CostState
  reviewHistory: ReviewResult[]
  onReview: () => Promise<ReviewResult>       // caller spawns reviewer agent
  onFix: (issues: ReviewIssue[]) => Promise<void>  // caller spawns builder agent
  onEvent: (event: WorkflowEvent) => void
}): Promise<ExitReason>
```

The `onReview` and `onFix` callbacks let the workflow implementation control HOW agents are spawned (via `runAgent()`), while the pipeline engine controls the LOOP logic (max cycles, stuck detection, cost checks).

**Estimated: ~180 lines**

---

### 4. `src/workflow/verdict.ts` — Review Output Parsing

**Source: pi-messenger `crew/utils/verdict.ts` — FULL FILE**

```
COPY entire file (55 lines):
  ParsedReview interface
  parseVerdict() function
```

Zero changes. Pure function, no dependencies. Parses markdown-formatted reviewer output into structured `{ verdict, summary, issues, suggestions }`.

**Estimated: 55 lines**

---

### 5. `src/workflow/recovery.ts` — Crash Recovery + Auto-Continue

**Two concerns in one file:**

**A) Session recovery** (from pi-planner `index.ts` L535-575):

```ts
// Pattern from pi-planner:
// 1. On session_start, scan appendEntry for active workflow
// 2. Load state.json from workflow dir
// 3. Check for stalled agents (timeout)
// 4. Notify user or auto-resume

function recoverActiveWorkflow(params: {
  ctx: ExtensionContext
  getEntries: () => SessionEntry[]
  cwd: string
}): { workflowId: string; state: WorkflowState } | null
```

**B) Continuation prompt** (from pi-coordination `auto-continue.ts` L160-273):

```ts
// ADAPT buildContinuationPrompt — simplified version
// Input: agent role, previous handoff, exit reason
// Output: prompt string for retry agent

function buildContinuationPrompt(params: {
  role: AgentRole
  previousHandoff: AgentHandoff | null
  exitReason: string
  attemptNumber: number
}): string
```

Key sections from pi-coordination's version to keep:
- Header with attempt number and exit reason (~5 lines)
- Files already modified with status icons (~15 lines)
- Last actions before failure (~10 lines)
- "Don't redo completed work" instructions (~5 lines)

Drop: `task.acceptanceCriteria`, `planContent` (we pass these via the workflow, not the recovery module).

**C) Stalled detection** (from pi-planner `executor/stalled.ts`):

```
COPY + generalize (34 lines → ~30 lines):
  findStalled()       — filter items past timeout
  formatStalledMessage() — human-readable notification
```

**Estimated: ~120 lines**

---

### 6. `src/workflow/progress.ts` — Progress Rendering

**Source: pi-coordination `coordinate/progress.ts` (L18-70) + `coordinate/render-utils.ts`**

Two outputs:

**A) Widget data** (for `ctx.ui.setWidget`):

```ts
function buildProgressLines(state: WorkflowState, theme: Theme): string[]
```

Uses status icons and phase pipeline rendering. Takes from:
- pi-manage-todo-list widget pattern (lines with icons)
- pi-coordination `renderPipelineRow` (phase bar concept)
- pi-coordination `formatDuration`, `formatCost` (pure formatters)

**B) Progress document** (human-readable, for `/flow` command):

```ts
function generateProgressDoc(state: WorkflowState, events: WorkflowEvent[]): string
```

Adapted from pi-coordination `generateProgressDoc` (L18-70). Simplified — we don't have worker states, just agent completions.

**Pure functions from pi-coordination to copy:**

| Function | Source | Lines |
|----------|--------|-------|
| `formatDuration(ms)` | render-utils.ts L104-111 | 8 |
| `formatCost(cost)` | render-utils.ts L112-114 | 3 |
| `getStatusIcon(status)` | render-utils.ts L74-86 | 13 — adapt to our statuses |
| `isPhasePast(phase, current)` | render-utils.ts L135-143 | 9 — adapt to our phases |

**Estimated: ~120 lines**

---

### 7. `src/workflow/tool-guard.ts` — Tool Restriction Per Role

**Source: pi-planner `mode/hooks.ts`**

| Block | Source lines | Action |
|-------|-------------|--------|
| `SAFE_BASH_PATTERNS` array | L33-56 | COPY — 24 lines of regex patterns for safe read-only bash |
| `DESTRUCTIVE_PATTERNS` array | L62-67 | COPY — 6 lines |
| `hasDangerousRedirect()` | L73-80 | COPY — 8 lines, pure function |
| `isSafeBashCommand()` | L82-88 | COPY — 7 lines, pure function |
| `tool_call` hook logic | L186-230 | ADAPT — instead of "plan mode" boolean, check agent role. Read-only roles (scout, explorer, reviewer, probe) → block write/edit + destructive bash. |

```ts
// Our version:
const READONLY_ROLES = new Set<AgentRole>(["scout", "explorer", "reviewer", "probe"])

function shouldBlockTool(role: AgentRole, toolName: string, input: unknown): 
  { block: true; reason: string } | undefined
```

**Not taking:** safety registry, skill classification, `before_agent_start` context injection — all planner-specific.

**Estimated: ~70 lines**

---

## Dependency Graph

```
types.ts           ← no deps (pure types)
    ↑
store.ts           ← types.ts (reads/writes typed JSON)
    ↑
pipeline.ts        ← types.ts, store.ts (phase transitions + state updates)
    ↑
verdict.ts         ← types.ts (pure parsing)
    
recovery.ts        ← types.ts, store.ts (session recovery + continuation prompts)
    
progress.ts        ← types.ts (pure rendering)
    
tool-guard.ts      ← types.ts (pure decision function)
```

No circular deps. Each file has a clear single responsibility.

---

## Total Estimate

| File | Lines | Copied | Adapted | New |
|------|-------|--------|---------|-----|
| `types.ts` | ~130 | 30 | 50 | 50 |
| `store.ts` | ~120 | 36 | 0 | 84 |
| `pipeline.ts` | ~180 | 35 | 95 | 50 |
| `verdict.ts` | ~55 | 55 | 0 | 0 |
| `recovery.ts` | ~120 | 30 | 50 | 40 |
| `progress.ts` | ~120 | 33 | 37 | 50 |
| `tool-guard.ts` | ~70 | 45 | 15 | 10 |
| **Total** | **~795** | **264** | **247** | **284** |

~33% direct copy, ~31% adapted, ~36% new.

---

## Schemas

### `state.json`

```ts
{
  id: "flow-a1b2c3d4",
  type: "fix",
  description: "remove any usage from codebase",
  
  currentPhase: "build",
  phases: {
    scout:   { phase: "scout",   status: "complete", startedAt: 1711700001, completedAt: 1711700046, attempt: 1 },
    build:   { phase: "build",   status: "running",  startedAt: 1711700060, attempt: 1 },
    review:  { phase: "review",  status: "pending",  attempt: 0 },
    complete:{ phase: "complete", status: "pending",  attempt: 0 }
  },
  
  reviewCycle: 0,
  maxReviewCycles: 3,
  exitReason: undefined,
  
  cost: {
    total: 0.23,
    byPhase: { scout: 0.08, build: 0.15, review: 0, complete: 0 },
    limit: 5.0,
    limitReached: false
  },
  
  activeAgents: [
    { agentId: "def456", role: "builder", phase: "build", startedAt: 1711700061 }
  ],
  completedAgents: [
    { agentId: "abc123", role: "scout", phase: "scout", handoffFile: "001-scout.json", duration: 45000, exitStatus: "completed" }
  ],
  
  startedAt: 1711700000,
  completedAt: undefined
}
```

### `handoffs/001-scout.json`

```ts
{
  agentId: "abc123",
  role: "scout",
  phase: "scout",
  
  summary: "Found 5 files with `any` usage: types.ts (3), index.ts (1), registry.ts (1)",
  findings: "## any Usage Analysis\n\n### src/types.ts\n- Line 22: `AgentTool<any>` ...",
  
  filesAnalyzed: ["src/types.ts", "src/index.ts", "src/agents/registry.ts", ...],
  filesModified: [],
  toolsUsed: 12,
  turnsUsed: 4,
  
  verdict: undefined,     // only set for reviewer handoffs
  issues: undefined,      // only set for reviewer handoffs
  
  duration: 45000,
  timestamp: 1711700046
}
```

### `events.jsonl` (one JSON object per line)

```ts
// All events share:
{ type: string, ts: number }

// Specific events:
{ type: "workflow_start", workflowType: "fix", description: "remove any", ts }
{ type: "phase_start", phase: "scout", ts }
{ type: "phase_complete", phase: "scout", duration: 45000, cost: 0.08, ts }
{ type: "agent_start", role: "scout", agentId: "abc123", phase: "scout", ts }
{ type: "agent_complete", role: "scout", agentId: "abc123", duration: 45000, toolUses: 12, exitStatus: "completed", ts }
{ type: "agent_error", role: "builder", agentId: "def456", error: "crashed", ts }
{ type: "handoff_written", from: "scout", handoffFile: "001-scout.json", ts }
{ type: "approval", phase: "build", decision: "approved", ts }
{ type: "review_verdict", verdict: "NEEDS_WORK", issueCount: 3, cycle: 1, ts }
{ type: "cost_update", total: 0.23, phase: "build", delta: 0.15, ts }
{ type: "workflow_complete", exitReason: "clean", totalDuration: 310000, totalCost: 0.45, ts }
{ type: "workflow_resumed", previousPhase: "build", ts }
```

### `tasks/task-1.json` (W4 only)

```ts
{
  id: "task-1",
  title: "Create auth types",
  status: "done",
  depends_on: [],
  created_at: "2026-03-29T10:00:00Z",
  updated_at: "2026-03-29T10:05:00Z",
  summary: "Created User, Session, Token interfaces in src/auth/types.ts",
  attempt_count: 1
}
```
