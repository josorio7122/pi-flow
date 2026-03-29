# Workflow Executor Design

> The missing piece: a generic phase execution engine that drives any workflow defined in `.md` files.

## What Exists

The workflow tooling layer has 10 modules providing building blocks:

| Module | Provides |
|--------|----------|
| `types.ts` | All type definitions (WorkflowDefinition, PhaseDefinition, WorkflowState, AgentHandoff, etc.) |
| `loader.ts` | Discovers `.md` workflow definitions from disk |
| `store.ts` | Atomic file I/O — state.json, handoffs/*.json, events.jsonl |
| `pipeline.ts` | State machine — createWorkflowState, updatePhaseStatus, checkTokenLimit, detectStuckIssues, runReviewFixLoop |
| `verdict.ts` | parseVerdict → SHIP / NEEDS_WORK / MAJOR_RETHINK |
| `task-store.ts` | Task CRUD with dependency resolution (createTask, getReadyTasks, completeTask) |
| `recovery.ts` | findStalled, buildContinuationPrompt, isRecoverableExit |
| `progress.ts` | Widget lines, status bar text, formatDuration |
| `helpers.ts` | refreshWidget, textResult, findLatestBookmark |
| `integration.ts` | Registers Workflow tool, /flow command, hooks — but **only handles start/status/abort** |

**What's missing**: The code that reads a workflow definition and actually executes each phase by spawning agents, collecting results, writing handoffs, and advancing state.

## Reference Patterns

### pi-coordination — Phase wrapper pattern

Each phase is a wrapper function: `runScoutPhaseWrapper`, `runReviewPhaseWrapper`, `runFixPhaseWrapper`. Pattern:

```
1. updatePhaseStatus(phase, "running", ctx)
2. Build config for the phase
3. Spawn agent(s) via runtime
4. Collect results (cost, output, files modified)
5. Save checkpoint
6. updatePhaseStatus(phase, "complete", ctx)
```

The `runReviewFixLoop` is a `while` loop:
```
while fixCycle < maxFixCycles:
  review = runReviewPhase(...)
  if review.allPassing → exit "clean"
  if detectStuckIssues(...) → exit "stuck"
  fixCycle++
  runFixPhase(..., review.issues)
```

**Key insight**: pi-coordination has hardcoded phase names (scout, planner, workers, review, fixes). We need the same pattern but driven by the `.md` definition's `phases` array.

### pi-messenger — Task-driven work

The `work.ts` handler:
```
1. Get ready tasks (dependencies satisfied)
2. Build prompt per task (includes task spec + context)
3. Spawn agents (with concurrency control)
4. Process results: succeeded → auto-review → if NEEDS_WORK → reset for retry
```

**Key insight**: The review-then-retry loop is per-task, not per-phase. pi-messenger's `reviewImplementation` spawns a reviewer, calls `parseVerdict`, and either marks SHIP or resets the task.

### pi-planner — In-session execution

pi-planner returns the executor prompt in the tool result, so the LLM executes in the same turn. This is the `single` mode pattern: the agent runs in the foreground, and completion is detected when the tool call returns.

**Key insight**: pi-planner doesn't spawn separate agents — it instructs the current LLM to follow the plan. For pi-flow, `single` mode spawns a real sub-agent via `manager.spawnAndWait()`.

## Design

### Core: `executor.ts` (~200 lines)

A generic function that takes a workflow definition + state and executes the current phase:

```ts
async function executeCurrentPhase({
  definition,    // WorkflowDefinition from .md
  state,         // WorkflowState from state.json
  cwd,           // working directory
  workflowId,    // flow ID
  pi,            // ExtensionAPI
  ctx,           // ExtensionContext
  manager,       // AgentManager (our sub-agent system)
  registry,      // Registry (agent configs)
}): Promise<PhaseOutcome>
```

It reads `state.currentPhase`, finds the matching `PhaseDefinition`, and dispatches by `mode`:

| Mode | Handler | What it does |
|------|---------|-------------|
| `single` | `executeSinglePhase` | Spawn one agent with role, wait, write handoff, return outcome |
| `parallel` | `executeParallelPhase` | Get ready tasks, spawn agents for each, collect results, write handoffs |
| `gate` | `executeGatePhase` | Return "waiting" — the Workflow tool's "continue" action resumes past it |
| `review-loop` | `executeReviewLoop` | Spawn reviewer → parseVerdict → if NEEDS_WORK spawn fixRole → loop |

### Phase handlers

**`executeSinglePhase`** (~80 lines):
```
1. Build prompt: agent role instructions + previous handoff (if contextFrom specified)
2. manager.spawnAndWait({ type: phase.role, prompt })
3. Collect result: record.result, record.toolUses, session.getSessionStats().tokens
4. Write handoff to store: writeHandoff(cwd, workflowId, { role, phase, summary, findings, ... })
5. Update state: updatePhaseStatus(phase, "complete"), accumulate tokens
6. Emit events: phase_complete, agent_complete, handoff_written
7. Return { outcome: "complete", handoff }
```

Source: Adapted from pi-coordination's `runScoutPhaseWrapper` pattern — but generic (role comes from definition, not hardcoded).

**`executeReviewLoop`** (~100 lines):
```
1. Read handoff from the phase being reviewed (contextFrom or previous phase)
2. while cycle < maxCycles:
   a. Spawn reviewer agent with handoff + diff context
   b. parseVerdict(reviewer.result) → SHIP / NEEDS_WORK / MAJOR_RETHINK
   c. if SHIP → return "complete"
   d. if MAJOR_RETHINK → return "escalate" (surface to user)
   e. Emit review_verdict event
   f. detectStuckIssues → if stuck → return "stuck"
   g. Spawn fixRole agent with issues from reviewer
   h. Write fix handoff
   i. cycle++
3. Return "max_cycles"
```

Source: Direct adaptation of pi-coordination's `runReviewFixLoop` + pi-messenger's `reviewImplementation` pattern (spawn reviewer → parseVerdict → reset/complete).

**`executeParallelPhase`** (~80 lines):
```
1. Get ready tasks from task-store (getReadyTasks)
2. For each ready task:
   a. Build prompt with task spec + previous handoff context
   b. manager.spawn({ type: phase.role, prompt, isBackground: true })
3. manager.waitForAll() or collect via onComplete callbacks
4. For each completed agent:
   a. Write handoff per task
   b. completeTask or blockTask based on result
5. Check if more ready tasks → repeat
6. When all tasks done → return "complete"
```

Source: Adapted from pi-messenger's `work.ts` handler — getReadyTasks → buildPrompt → spawnAgents → processResults.

**`executeGatePhase`** (~20 lines):
```
1. Update phase status to "gate-waiting"
2. Write state
3. Return { outcome: "gate-waiting" }
// The Workflow tool's "continue" action will advance past this
```

Source: pi-planner's approval flow pattern — pause execution, return to user, resume on explicit action.

### Prompt building: `prompt-builder.ts` (~80 lines)

Builds the agent prompt from workflow context:

```ts
function buildPhasePrompt({
  phase,          // PhaseDefinition
  definition,     // WorkflowDefinition
  state,          // WorkflowState
  previousHandoff, // AgentHandoff | null (from contextFrom phase)
  cwd,
}): string
```

The prompt includes:
1. The workflow description
2. The phase description
3. Previous agent's handoff (findings, files analyzed/modified)
4. Orchestrator instructions from the .md body
5. Token budget remaining
6. Review issues (if in review-loop and this is a fix iteration)

Source: Adapted from pi-messenger's `buildWorkerPrompt` and pi-coordination's worker context injection.

### Handoff protocol: using existing `store.ts`

When an agent completes, the executor writes a structured `AgentHandoff` to `handoffs/NNN-role.json`:

```ts
writeHandoff(cwd, workflowId, {
  agentId: record.id,
  role: phase.role,
  phase: phase.name,
  summary: extractSummary(record.result),
  findings: record.result,
  filesAnalyzed: [], // Could be populated if agent reports them
  filesModified: [], // Could be populated from git diff
  toolsUsed: record.toolUses,
  turnsUsed: turnCount,
  verdict: undefined, // Set by reviewer
  issues: undefined,  // Set by reviewer
  duration,
  timestamp: Date.now(),
})
```

The next phase reads the previous handoff via `contextFrom`:
```ts
const handoffs = listHandoffs(cwd, workflowId);
const previousHandoff = handoffs.find(h => h.phase === phase.contextFrom);
```

This is already built — `writeHandoff`, `readHandoff`, `listHandoffs` exist in `store.ts`.

### Advancement: the orchestration loop in `integration.ts`

After `executeCurrentPhase` returns, `integration.ts` advances the state machine:

```ts
const outcome = await executeCurrentPhase({ ... });

if (outcome.type === "complete") {
  // Advance to next phase
  const nextPhaseIndex = definition.phases.findIndex(p => p.name === state.currentPhase) + 1;
  if (nextPhaseIndex >= definition.phases.length) {
    // Workflow complete
    state.exitReason = "clean";
    state.completedAt = Date.now();
  } else {
    state.currentPhase = definition.phases[nextPhaseIndex].name;
  }
  writeState(cwd, workflowId, state);
}

if (outcome.type === "gate-waiting") {
  // Pause — user will say "continue" which calls the Workflow tool with action: "continue"
  // The "continue" handler advances past the gate and calls executeCurrentPhase for the next phase
}

if (outcome.type === "stuck" || outcome.type === "max_cycles") {
  state.exitReason = outcome.type;
  state.completedAt = Date.now();
  writeState(cwd, workflowId, state);
}
```

### Integration changes to existing `integration.ts`

The `startWorkflow` function currently returns text telling the LLM to spawn agents. Instead, it should:

1. Create state (already does this)
2. Call `executeCurrentPhase` for the first phase
3. Return the result (or gate-waiting status)

The `continue` action should:
1. If current phase is a gate → advance to next phase → call `executeCurrentPhase`
2. If workflow was interrupted → call `executeCurrentPhase` for current phase

### Token tracking

After each agent completes, accumulate tokens into state:
```ts
const stats = record.session?.getSessionStats();
state.tokens.total += stats?.tokens?.total ?? 0;
state.tokens.byPhase[phase.name] = (state.tokens.byPhase[phase.name] ?? 0) + (stats?.tokens?.total ?? 0);
if (checkTokenLimit(state.tokens)) {
  state.exitReason = "token_limit";
}
```

This uses existing `checkTokenLimit` from `pipeline.ts`.

## File Plan

| File | Lines est | What | Wires |
|------|-----------|------|-------|
| `executor.ts` | ~200 | `executeCurrentPhase` + dispatch by mode | `pipeline.ts`, `store.ts`, `recovery.ts` |
| `phase-single.ts` | ~80 | `executeSinglePhase` | `store.writeHandoff`, `pipeline.updatePhaseStatus` |
| `phase-review.ts` | ~100 | `executeReviewLoop` | `verdict.parseVerdict`, `pipeline.detectStuckIssues` |
| `phase-parallel.ts` | ~80 | `executeParallelPhase` | `task-store.*` |
| `phase-gate.ts` | ~20 | `executeGatePhase` | `pipeline.updatePhaseStatus` |
| `prompt-builder.ts` | ~80 | Build agent prompt from workflow context | `store.readHandoff`, `store.listHandoffs` |
| Update `integration.ts` | +50 | Wire executor into start/continue actions | `executor.ts` |

**Total: ~610 new lines + ~50 lines modified.**

After this, every module we built is wired:
- `verdict.ts` → used by `phase-review.ts`
- `task-store.ts` → used by `phase-parallel.ts`
- `pipeline.ts` (all exports) → used by `executor.ts`
- `store.ts` (handoffs, state) → used by all phase handlers
- `recovery.ts` → used by `executor.ts` for crash recovery
- `progress.ts` → already wired via `integration.ts` widget

And W1-W4 are just `.md` files:

```yaml
# .pi/workflows/research.md
---
name: research
phases:
  - name: probe
    role: probe
    mode: single
---
```

```yaml
# .pi/workflows/fix.md
---
name: fix
phases:
  - name: scout
    role: scout
    mode: single
  - name: approve
    mode: gate
  - name: build
    role: builder
    mode: single
    contextFrom: scout
  - name: review
    role: reviewer
    mode: review-loop
    fixRole: builder
    maxCycles: 3
---
```

The engine doesn't know about "fix" or "research" — it reads the phases and executes them generically.
