# Tooling Gaps — What's Missing From the Plan

> Audit of the workflow tooling design. Everything that was missing or underspecified.

---

## Gaps Found

### 1. Task Store (`task-store.ts`) — Was mentioned as "W4 only", but it's core tooling

Any workflow with a `parallel` mode phase needs task management. The planner produces tasks, the parallel builders each take one. Even in W3 (fix), the scout could find multiple independent issues that could be fixed in parallel.

**Source: pi-messenger `crew/store.ts`**

| Function | Source lines | What we need |
|----------|-------------|-------------|
| `createTask()` | L173-216 | Create task from plan output |
| `getTask()` | L217-221 | Read single task |
| `updateTask()` | L222-235 | Update status |
| `getTasks()` | L236-254 | List all tasks |
| `getReadyTasks()` | L449-465 | **Key** — find tasks whose dependencies are all done |
| `startTask()` | L329-341 | Mark in_progress |
| `completeTask()` | L342-371 | Mark done with summary |
| `blockTask()` | L372-386 | Mark blocked with reason |
| `resetTask()` | L399-448 | Reset to todo for retry |

Also need from pi-messenger `crew/store.ts`:
| Helper | Lines | What |
|--------|-------|------|
| `readJson()` | L43-50 | Already in store.ts |
| `writeJson()` | L52-58 | Already in store.ts |
| `getBaseCommit()` | L316-328 | Get current git commit (for diff-based review) |

**Estimated: ~150 lines** (separate file, not part of store.ts)

---

### 2. Integration File (`integration.ts`) — Who wires everything together?

The tooling docs define 8 files but NONE of them registers tools, commands, or hooks with pi. We need a file that:

- Registers the workflow trigger tool (the LLM calls this to start a workflow)
- Registers `/flow` command (user inspects/manages active workflow)
- Registers `session_start` hook (crash recovery)
- Registers `turn_end` / `agent_end` hooks (widget updates)
- Calls `ctx.ui.setWidget()` and `ctx.ui.setStatus()`
- Manages the active workflow lifecycle

**Source patterns:**

| Pattern | From | What |
|---------|------|------|
| Tool registration with TypeBox schema | pi-flow's own `index.ts` (existing `Agent` tool) | Register a `Workflow` tool |
| `/flow` command with `ctx.ui.select()` | pi-planner `/plans` command (L470-510) | Interactive workflow management |
| `session_start` recovery hook | pi-planner (L535-575) | Scan entries, load state, resume |
| Widget update on `turn_end` | pi-manage-todo-list (L48-50) | Refresh progress widget |
| Status bar with `ctx.ui.setStatus()` | pi-messenger (L285) | `[flow] build ● 3/5 | $0.45` |
| `appendEntry` for state persistence | pi-planner (L74) | Bookmark active workflow |

**Estimated: ~200 lines**

---

### 3. Cost Tracking — How do we get cost from agent sessions?

The current pi-flow code gets tokens via `session.getSessionStats().tokens.total` (see `helpers.ts` L118). But this is TOKEN count, not COST. To compute cost we need:
- Token counts (available from `getSessionStats()`)
- Model pricing (not directly available)

**Options:**
1. **Track tokens, not dollars** — simpler, display as "12.5K tokens" not "$0.45". Let the user do the math.
2. **Estimate cost from model name** — maintain a pricing table. Fragile, goes stale.
3. **Use pi's cost if available** — check if `getContextUsage()` or session stats include cost.

**Recommendation:** Track tokens for now. The `CostState` type becomes `TokenState`:
```ts
interface TokenState {
  total: number           // total tokens across all agents
  byPhase: Record<string, number>
  limit: number           // token limit (0 = no limit)
  limitReached: boolean
}
```

Source for token extraction: pi-flow's own `helpers.ts` `getTokenCount()` (L116-118).

---

### 4. Gate Phase Implementation — How does user approval work?

The `gate` phase mode pauses the workflow for user approval. Needs:

**Source: pi-planner `index.ts` L525-580 (plan review UI)**

```ts
// Pattern from pi-planner:
const action = await ctx.ui.select(detailText, ["Approve", "Approve & Execute", "Reject", "Cancel"])
```

But there's a problem: `ctx.ui.select()` is only available during a command handler or tool execution — NOT during a background workflow. The workflow is triggered by the LLM calling a tool, and that tool returns before the approval gate is reached.

**Solution:** The gate phase returns a tool result asking for approval:

```
Tool result: "Scout found 5 files with `any` usage. [details]
Awaiting your approval to proceed with fixes. Say 'approve' to continue or 'reject' to cancel."
```

The orchestrator LLM sees this and waits for the user. When the user says "go ahead", the LLM calls the workflow tool again with `action: "continue"`. The workflow resumes from the gate phase.

This means the workflow tool needs TWO actions:
- `action: "start"` — begin a new workflow
- `action: "continue"` — resume past a gate (or after crash recovery)

This is actually simpler and more natural than `ctx.ui.select()` because it keeps the user in the normal conversation flow.

---

### 5. Parallel Phase Tracking — How do we track N background agents?

The `parallel` phase mode spawns N agents via `run_in_background: true`. We need to:
1. Know how many agents to spawn (from task count)
2. Track which are running, which completed
3. Collect all handoffs when all complete
4. Handle partial failures (some succeed, some fail)

**Source patterns:**

| Pattern | From |
|---------|------|
| Background agent tracking | pi-flow's existing `createAgentManager` — already tracks running/completed/queued |
| Group completion notification | pi-flow's existing `createGroupJoinManager` — batches completions |
| Handoff collection | NEW — write handoff per agent, pipeline reads all when group completes |

The existing pi-flow agent system already handles this:
1. Spawn N agents with `run_in_background: true` in the same turn → group join batches them
2. `onComplete` callback fires for each → we write handoff file + update state.json
3. Group join fires when all complete → we transition to next phase

**No new code needed for the parallel execution itself.** But `pipeline.ts` needs to handle the `parallel` phase mode: spawn agents, register group, wait for group completion, collect handoffs.

---

### 6. Agent Configs for Workflow Roles — Missing from plan

We need `.md` agent configs for each role. These define tools, model, and system prompt.

**Source: pi-coordination `agents/*.md`** (study format, write our own)

| Role | Tools | Prompt Mode | Key prompt guidance |
|------|-------|-------------|-------------------|
| `probe` | read, bash, grep, find, ls | append | Research focus. Use exa for web search. Query databases. Report findings. |
| `explorer` | read, bash, grep, find, ls | append | Deep-read code. Map dependencies. Produce structured understanding. |
| `scout` | read, bash, grep, find, ls | append | Targeted analysis. Find specific patterns. Report locations + context. |
| `clarifier` | read, bash, grep, find, ls | append | Ask user questions one at a time. Build spec from answers. SDD approach. |
| `planner` | read, bash, grep, find, ls | append | Create task graph from spec. Define dependencies. Structured output. |
| `test-writer` | read, write, edit, bash | append | Write failing tests from spec. Run to confirm red. TDD discipline. |
| `builder` | read, write, edit, bash | append | Implement code. Make tests pass. Follow the plan. |
| `reviewer` | read, bash, grep, find, ls | append | Review changes against spec+plan. Output structured verdict (SHIP/NEEDS_WORK/MAJOR_RETHINK). |

**~8 files, ~50-100 lines each**

---

### 7. Tool Guard Rethink — Agent configs already restrict tools

The `tool-guard.ts` was designed to filter bash commands for read-only roles. But agent configs already restrict tools via `tools:` frontmatter. If scout has `tools: read, bash, grep, find, ls` — it can't call `write` or `edit`.

The remaining concern is **bash command filtering** — a scout with `bash` could still run `rm -rf`. But:
- pi-coordination's agents don't filter bash commands (they rely on system prompt + tool restriction)
- pi-planner filters bash only in "plan mode" — a special restriction mode

**Decision:** Drop `tool-guard.ts` from the tooling layer. Agent configs handle tool restriction. Bash filtering can be added later if needed (it's a hook, not core infrastructure).

**This removes ~70 lines from the plan.**

---

## Updated Tooling File List

| # | File | Lines | Purpose | Source |
|---|------|-------|---------|--------|
| 1 | `types.ts` | ~150 | All type definitions (WorkflowDefinition, PhaseDefinition, WorkflowState, AgentHandoff, etc.) | pi-coordination types + pi-messenger types + new |
| 2 | `loader.ts` | ~100 | Discover + parse workflow `.md` files | Pattern from pi-flow `agents/custom.ts` |
| 3 | `store.ts` | ~120 | File I/O primitives + workflow dir management + state/handoff/event operations | pi-messenger `crew/store.ts` helpers + new |
| 4 | `task-store.ts` | ~150 | Task CRUD + dependency resolution + state transitions | pi-messenger `crew/store.ts` task operations |
| 5 | `pipeline.ts` | ~200 | Phase engine — transitions, token tracking, review-fix loop, gate handling | pi-coordination `pipeline.ts` |
| 6 | `verdict.ts` | ~55 | Parse reviewer output → SHIP/NEEDS_WORK/MAJOR_RETHINK | pi-messenger `crew/utils/verdict.ts` (full copy) |
| 7 | `recovery.ts` | ~120 | Session recovery + continuation prompts + stalled detection | pi-planner + pi-coordination |
| 8 | `progress.ts` | ~100 | Widget data + status bar + format helpers | pi-manage-todo-list widget + pi-coordination render-utils |
| 9 | `integration.ts` | ~200 | Wire to pi: register tool, `/flow` command, hooks, widget, status | pi-planner/pi-coordination patterns |
| **Total** | | **~1,195** | | |

Plus: ~8 agent config `.md` files + ~4 workflow definition `.md` files

---

## Source Reference Matrix

Every tooling file mapped to its exact source:

### `types.ts` (~150 lines)
| Symbol | Source | Action |
|--------|--------|--------|
| `WorkflowDefinition`, `PhaseDefinition`, `WorkflowConfig` | NEW | Supports file-based workflow definitions |
| `WorkflowPhase` (string, not union) | ADAPT pi-coordination `PipelinePhase` | Generic — defined by workflow files |
| `PhaseResult` | COPY pi-coordination L164-172 | `{ phase, status, startedAt?, completedAt?, error?, attempt }` |
| `ExitReason` | COPY pi-coordination L173 | `"clean" \| "stuck" \| "max_cycles" \| "cost_limit" \| "user_abort"` |
| `WorkflowState` | ADAPT pi-coordination `PipelineState` L175-189 | Add `activeAgents`, `completedAgents`, `workflowType` |
| `TokenState` | ADAPT pi-coordination `CostState` L231-238 | Rename cost→tokens, drop `byWorker` |
| `AgentHandoff` | NEW | `{ agentId, role, phase, summary, findings, filesAnalyzed, filesModified, verdict?, issues? }` |
| `ReviewVerdict` | COPY pi-messenger `crew/types.ts` L145 | `"SHIP" \| "NEEDS_WORK" \| "MAJOR_RETHINK"` |
| `ReviewIssue` | ADAPT pi-coordination L195-206 | Drop `originalWorker`, `fixAttempts` |
| `WorkflowEvent` | NEW (informed by pi-coordination `CoordinationEvent` + pi-messenger `FeedEvent`) | Discriminated union |
| `ActiveAgent`, `CompletedAgent` | NEW | Agent tracking within workflow |
| `Task` | ADAPT pi-messenger `crew/types.ts` L34-65 | Drop `base_commit`, `assigned_to`, `milestone`, `model`, `skills`, `evidence` |

### `loader.ts` (~100 lines)
| Symbol | Source | Action |
|--------|--------|--------|
| `loadWorkflowDefinitions()` | ADAPT pi-flow `agents/custom.ts` `loadCustomAgents()` | Same discovery pattern: project > global > builtin |
| `loadFromDir()` | ADAPT pi-flow `agents/custom.ts` L37-87 | Same dir scanning + `parseFrontmatter()` |
| Phase parsing from YAML arrays | NEW | Parse `phases:` frontmatter into `PhaseDefinition[]` |

### `store.ts` (~120 lines)
| Symbol | Source | Action |
|--------|--------|--------|
| `ensureDir()` | COPY pi-messenger L17-20 | |
| `readJson()` | COPY pi-messenger L43-50 | |
| `writeJson()` | COPY pi-messenger L52-58 | Atomic: temp + rename |
| `appendJsonl()` | ADAPT pi-coordination `appendEvent` L157-162 | `fs.appendFileSync(path, JSON.stringify(event) + "\n")` |
| `readJsonl()` | ADAPT pi-coordination `getEvents` L163-175 | Read + split + parse lines |
| Workflow dir operations | NEW | `initWorkflowDir`, `readState`, `writeState`, `updateState`, `writeHandoff`, `readHandoff`, `listHandoffs` |

### `task-store.ts` (~150 lines)
| Symbol | Source | Action |
|--------|--------|--------|
| `createTask()` | ADAPT pi-messenger L173-216 | Simplified — drop 6 fields |
| `getTask()` | COPY pi-messenger L217-221 | |
| `updateTask()` | COPY pi-messenger L222-235 | |
| `getTasks()` | ADAPT pi-messenger L236-254 | |
| `getReadyTasks()` | COPY pi-messenger L449-465 | **Key function** — dependency check |
| `completeTask()` | ADAPT pi-messenger L342-371 | Drop evidence |
| `blockTask()` | COPY pi-messenger L372-386 | |
| `resetTask()` | ADAPT pi-messenger L399-448 | Simplified — no cascade |

### `pipeline.ts` (~200 lines)
| Symbol | Source | Action |
|--------|--------|--------|
| `createWorkflowState()` | ADAPT pi-coordination `initializePipelineState` L75-101 | Initialize from `WorkflowDefinition.phases` |
| `createTokenState()` | ADAPT pi-coordination `initializeCostState` L103-120 | Tokens not dollars |
| `updatePhaseStatus()` | ADAPT pi-coordination L122-173 | Redirect observability calls to `onEvent` callback (routes to `appendEvent`/`events.jsonl`) |
| `checkTokenLimit()` | ADAPT pi-coordination `checkCostLimit` L193-209 | Rename cost→tokens, emit event via `onEvent` |
| `detectStuckIssues()` | COPY pi-coordination L211-229 | Pure function, zero changes |
| `runReviewFixLoop()` | ADAPT pi-coordination L757-817 | Takes `onReview`/`onFix` callbacks |
| Gate phase handling | NEW | Return pending status, resume on continue |

### `verdict.ts` (~55 lines)
| Symbol | Source | Action |
|--------|--------|--------|
| `ParsedReview` | COPY pi-messenger `crew/utils/verdict.ts` | Full interface |
| `parseVerdict()` | COPY pi-messenger `crew/utils/verdict.ts` | Full function, zero changes |

### `recovery.ts` (~120 lines)
| Symbol | Source | Action |
|--------|--------|--------|
| `recoverActiveWorkflow()` | ADAPT pi-planner `session_start` handler L535-575 | Scan entries → load state → check stalled |
| `findStalled()` | ADAPT pi-planner `executor/stalled.ts` L13-22 | Generalize from Plan to agent |
| `formatStalledMessage()` | ADAPT pi-planner `executor/stalled.ts` L27-34 | Generic agent message |
| `buildContinuationPrompt()` | ADAPT pi-coordination `auto-continue.ts` L160-273 | Keep: attempt header, files modified, last actions, instructions. ~70 lines from 114. |
| `isRecoverableExit()` | COPY pi-coordination `auto-continue.ts` L305-320 | Pure function |

### `progress.ts` (~100 lines)
| Symbol | Source | Action |
|--------|--------|--------|
| `formatDuration()` | COPY pi-coordination `render-utils.ts` L104-111 | 8 lines |
| `formatTokens()` | Already in pi-flow `ui/formatters.ts` | Reuse existing |
| `getStatusIcon()` | ADAPT pi-coordination `render-utils.ts` L74-86 | Our phase statuses |
| `buildProgressLines()` | ADAPT pi-manage-todo-list `ui/todo-widget.ts` L28-60 | Phase icons + agent status |
| `buildStatusText()` | ADAPT pi-messenger `index.ts` L285 | `[flow] build ● 3/5 | 12K tokens` |

### `integration.ts` (~200 lines)
| Symbol | Source | Action |
|--------|--------|--------|
| Workflow tool registration | ADAPT pi-flow's own `index.ts` Agent tool pattern | TypeBox schema: `{ action, workflow_type?, description? }` |
| `/flow` command | ADAPT pi-planner `/plans` command L470-510 | `ctx.ui.select()` for workflow management |
| `session_start` hook | ADAPT pi-planner L535-575 | Call `recoverActiveWorkflow()` |
| Widget update | ADAPT pi-manage-todo-list `index.ts` L48-50 | `pi.on("turn_end")` → update widget |
| Status bar | ADAPT pi-messenger L285 | `ctx.ui.setStatus("flow", text)` |
| `appendEntry` bookmark | COPY pi-planner L74 | `pi.appendEntry("pi-flow:active", { workflowDir })` |

---

## Removed From Plan

| Item | Why removed |
|------|-------------|
| `tool-guard.ts` (~70 lines) | Agent configs already restrict tools via `tools:` frontmatter. Bash filtering is a nice-to-have, not core infrastructure. |
| Dollar-based cost tracking | No reliable way to get cost from pi's API. Track tokens instead (available via `getSessionStats().tokens.total`). |
