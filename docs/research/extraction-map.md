# Extraction Map — Exact Code to Copy/Adapt

> For each target file in pi-flow, the exact source functions/types/blocks and what changes.

---

## Phase 1: Foundation

### 1. `src/workflow/types.ts` (~150 lines)

**From pi-coordination `coordinate/types.ts`:**

| Symbol | Lines | Action | Changes |
|--------|-------|--------|---------|
| `PipelinePhase` type (L153-163) | 11 | ADAPT | Rename to `WorkflowPhase`. Values: `"probe"`, `"explore"`, `"scout"`, `"clarify"`, `"plan"`, `"test"`, `"build"`, `"review"`, `"complete"`, `"failed"` |
| `PhaseResult` interface (L164-172) | 9 | COPY | As-is, change `PipelinePhase` → `WorkflowPhase` |
| `ExitReason` type (L173) | 1 | COPY | As-is |
| `PipelineState` interface (L175-189) | 15 | ADAPT | Rename to `WorkflowState`. Drop `scoutContext`, `planPath`, `planHash`. Add `workflowType: WorkflowType`, `handoffs: AgentHandoff[]` |
| `ReviewIssue` interface (L195-206) | 12 | COPY | As-is |
| `CostState` interface (L231-238) | 8 | ADAPT | Change `byPhase` key type to `WorkflowPhase` |

**From pi-messenger `crew/types.ts`:**

| Symbol | Lines | Action | Changes |
|--------|-------|--------|---------|
| `ReviewVerdict` type (L145) | 1 | COPY | `"SHIP" \| "NEEDS_WORK" \| "MAJOR_RETHINK"` |
| `ReviewResult` interface (L147-152) | 6 | COPY | As-is |
| `TaskStatus` type (L32) | 1 | ADAPT | `"todo" \| "in_progress" \| "done" \| "blocked"` |
| `Task` interface (L34-65) | 32 | ADAPT | Keep: `id`, `title`, `status`, `depends_on`, `created_at`, `updated_at`, `summary`, `attempt_count`. Drop: `base_commit`, `assigned_to`, `milestone`, `model`, `skills`, `evidence`, `review_count`, `last_review` |

**New (not from any repo):**

| Symbol | Est lines | Description |
|--------|-----------|-------------|
| `WorkflowType` | 1 | `"research" \| "explore" \| "fix" \| "feature"` |
| `AgentRole` | 1 | `"probe" \| "explorer" \| "scout" \| "clarifier" \| "planner" \| "test-writer" \| "builder" \| "reviewer"` |
| `AgentHandoff` | 10 | `{ fromRole, toRole, summary, findings, filesAnalyzed, filesModified, context }` |
| `WorkflowConfig` | 15 | Per-workflow config: `maxReviewCycles`, `costLimit`, `phases` |

---

### 2. `src/workflow/pipeline.ts` (~250 lines)

**From pi-coordination `coordinate/pipeline.ts`:**

| Function/Type | Source lines | Action | Changes |
|---------------|-------------|--------|---------|
| `PipelineConfig` interface (L27-51) | 25 | ADAPT | Rename to `WorkflowRunConfig`. Drop `planPath`, `planDir`, `agents[]`, `skipScout`, `planner`, `selfReview`, `supervisor`. Add `workflowType`, `costLimit`, `maxReviewCycles`. |
| `PipelineContext` interface (L52-65) | 14 | ADAPT | Rename to `WorkflowRunContext`. Drop `storage` (FileBasedStorage), `obs` (observability), `plannerTasks`, `plannerBackgroundAbort`. Keep `pipelineState` → `workflowState`, `costState`, `reviewHistory`, `signal`, `onUpdate`. Add `handoffs: AgentHandoff[]`. |
| `PipelineResult` interface (L67-73) | 7 | ADAPT | Rename to `WorkflowResult`. Keep `success`, `exitReason`. Add `handoffs`, `finalOutput`. |
| `initializePipelineState()` (L75-101) | 27 | ADAPT | Rename. Initialize phases from `WorkflowType` → phase list mapping. |
| `initializeCostState()` (L103-120) | 18 | COPY | Change `byPhase` key type. |
| `updatePhaseStatus()` (L122-173) | 52 | ADAPT | Strip observability calls (`ctx.obs?.events`). Keep phase state transitions, timing, event appending. |
| `checkCostLimit()` (L193-209) | 17 | ADAPT | Strip observability. Keep cost check logic. |
| `runReviewFixLoop()` (L757-817) | 61 | ADAPT | **This is key.** Strip `runIntegrationReviewWrapper`. Keep: while loop, `checkCostLimit`, review → `detectStuckIssues` → fix → repeat. Replace `runReviewPhaseWrapper`/`runFixPhaseWrapper` with calls to our reviewer/builder agents via existing `runAgent()`. |

**From pi-coordination `coordinate/pipeline.ts` — `detectStuckIssues()` (L211-229):**

| Function | Source lines | Action | Changes |
|----------|-------------|--------|---------|
| `detectStuckIssues()` | 19 | COPY | Pure function. No changes needed — operates on `ReviewIssue[]`. |

**NOT taking** from pipeline.ts:
- `runScoutPhaseWrapper` (271→358) — our phases call `runAgent()`, not subagent spawning
- `runPlannerPhaseWrapper` (359→474) — same reason
- `runReviewPhaseWrapper` (475→606) — we build our own that calls `runAgent()`
- `runFixPhaseWrapper` (607→691) — same
- `runIntegrationReviewWrapper` (692→756) — we don't have integration phase
- `saveProgressDoc()` (175-191) — moves to `progress.ts`

---

### 3. `src/workflow/verdict.ts` (~55 lines)

**From pi-messenger `crew/utils/verdict.ts` — FULL FILE COPY:**

| Symbol | Lines | Action | Changes |
|--------|-------|--------|---------|
| `ParsedReview` interface | 6 | COPY | Rename to `ReviewVerdict` (or keep, reference from types.ts) |
| `parseVerdict()` function | 49 | COPY | Pure function. Zero changes. |

---

### 4. `src/workflow/agent-context.ts` (~150 lines)

**From pi-coordination `coordinate/worker-context.ts`:**

| Symbol | Source lines | Action | Changes |
|--------|-------------|--------|---------|
| `FileModification` interface (L30-41) | 12 | COPY | As-is |
| `ActionRecord` interface (L64-74) | 11 | COPY | As-is |
| `WorkerContext` interface (L75-90) | 16 | ADAPT | Rename to `AgentContext`. Drop `pendingTests`, `completionAttempts`. Add `role: AgentRole`, `handoff?: AgentHandoff`. |
| `createFreshContext()` (L225-247) | 23 | ADAPT | Rename to `createFreshAgentContext()`. Initialize with role. |
| `generateContinuationNotes()` (L409-445) | 37 | COPY | Pure function. Generates "what to do next" from context. |
| `renderContextToMarkdown()` (L472-581) | 110 | ADAPT | Simplify — we don't need the full markdown format. Keep: files modified section, discoveries, last actions. ~50 lines. |

**From pi-coordination `coordinate/auto-continue.ts`:**

| Symbol | Source lines | Action | Changes |
|--------|-------------|--------|---------|
| `buildContinuationPrompt()` (L160-273) | 114 | ADAPT | Core logic stays: header with attempt number, files already modified, discoveries, last actions, instructions. Drop: `task.files`, `task.acceptanceCriteria`, `planContent` sections (we pass these via `AgentHandoff`). ~70 lines. |
| `isRecoverableExit()` (L305-end) | 15 | COPY | Pure function. |

**NOT taking:**
- `processWorkerExit()` — tied to coordinator/task-queue pattern. We handle exits in the pipeline.
- `loadContext()`/`saveContext()` — file I/O tied to coordination's directory structure. We write our own using `appendEntry` or simple JSON.
- `parseContextFromMarkdown()` — we won't use markdown-based context storage.
- `ContextUpdater` — tied to tool_result event processing. Our agents report via handoff.

---

### 5. `src/ui/progress-widget.ts` (~80 lines)

**From pi-manage-todo-list `ui/todo-widget.ts`:**

| Symbol | Source lines | Action | Changes |
|--------|-------------|--------|---------|
| `STATUS_ICONS` map (L18-22) | 5 | ADAPT | Change to phase/agent status icons: `{ complete: "✓", running: "●", pending: "○", failed: "✗", skipped: "—" }` |
| `updateWidget()` (L28-60) | 33 | ADAPT | Replace todo rendering with: phase pipeline bar + active agent + task progress. Same `ctx.ui.setWidget(id, renderFn)` pattern. |
| `clearWidget()` (L63-65) | 3 | COPY | As-is. |

**From pi-coordination `coordinate/render-utils.ts`:**

| Symbol | Source lines | Action | Changes |
|--------|-------------|--------|---------|
| `formatDuration()` (L104-111) | 8 | COPY | Pure function. |
| `formatCost()` (L112-114) | 3 | COPY | Pure function. |
| `getStatusIcon()` (L74-86) | 13 | ADAPT | Map our phase statuses to icons. |
| `isPhasePast()` (L135-143) | 9 | ADAPT | Use our `WorkflowPhase` ordering. |

---

### 6. `src/workflow/truncate.ts` (~121 lines)

**From pi-coordination `subagent/truncate.ts` — FULL FILE COPY:**

| Symbol | Lines | Action | Changes |
|--------|-------|--------|---------|
| `OutputLimits` interface | 4 | COPY | |
| `OutputMetrics` interface | 5 | COPY | |
| `TruncationResult` interface | 8 | COPY | |
| `measureOutput()` | 7 | COPY | |
| `truncateOutputHead()` | ~70 | COPY | |
| Internal helpers | ~27 | COPY | `countLines`, `utf8ByteLengthForCodePoint` |

Zero changes. Pure functions, no dependencies.

---

### 7. `src/workflow/stalled.ts` (~40 lines)

**From pi-planner `executor/stalled.ts` — FULL FILE COPY + generalize:**

| Symbol | Lines | Action | Changes |
|--------|-------|--------|---------|
| `findStalledPlans()` | 12 | ADAPT | Rename to `findStalledAgents()`. Change `Plan` param to `{ id: string, startedAt?: string }`. Same timeout logic. |
| `formatStalledPlanMessage()` | 10 | ADAPT | Rename to `formatStalledMessage()`. Generalize the message format. |

---

## Phase 2: W1 + W2

### 8. Agent Role Configs (`.md` files)

**From pi-coordination `agents/*.md` — STUDY format, write new:**

We need to create agent config `.md` files for `probe` and `explorer` roles. Study the frontmatter format from pi-coordination:

```yaml
---
name: probe
description: Research and verification agent
tools: read, bash, grep, find, ls
system-prompt-mode: append
---
```

These get loaded by the EXISTING `agents/custom.ts` loader — no code changes needed.

### 9-10. `src/workflows/research.ts` and `src/workflows/explore.ts`

**NEW** — these are thin orchestration functions that call `runAgent()`. No code to copy.

### 11. `src/workflow/router.ts` (~150 lines)

**NEW** — LLM-driven intent classification. No code to copy from repos.

### 12. `src/workflow/tool-guard.ts` (~80 lines)

**From pi-planner `mode/hooks.ts`:**

| Symbol | Source lines | Action | Changes |
|--------|-------------|--------|---------|
| `PLAN_MODE_BLOCKED_TOOLS` set (L22-26) | 5 | ADAPT | Create per-role tool restrictions: `READONLY_ROLES` (scout, explorer, reviewer, probe) block `write`, `edit`. |
| `SAFE_BASH_PATTERNS` array (L33-56) | 24 | COPY | Same safe bash patterns for read-only agents. |
| `DESTRUCTIVE_PATTERNS` array (L62-67) | 6 | COPY | Same destructive patterns. |
| `hasDangerousRedirect()` (L73-80) | 8 | COPY | Pure function. |
| `isSafeBashCommand()` (L82-88) | 7 | COPY | Pure function. |
| `tool_call` hook registration pattern (L186-230) | ~45 | ADAPT | Instead of "plan mode" boolean, check active agent's role. If role is read-only, block destructive tools. |

**NOT taking:**
- `before_agent_start` context injection (L98-180) — we inject context via agent prompt, not hooks
- Safety registry / skill classification — we don't need this
- `context` event filtering — not applicable

---

## Phase 3: W3

### 13-14. `src/workflows/fix.ts` + agent configs

**From pi-coordination `coordinate/pipeline.ts`:**

The `runReviewFixLoop()` pattern is already extracted in Phase 1. `fix.ts` will:
1. Run scout agent via `runAgent()` → get handoff
2. Present findings to user → approval gate (pattern from pi-planner `index.ts` L525-580, the `ctx.ui.select()` approve/reject pattern)
3. Run builder agent with scout handoff as context
4. Run reviewer agent
5. If NEEDS_WORK → loop (using `runReviewFixLoop` from pipeline.ts)

### 15. Review-fix loop — already in `pipeline.ts` from Phase 1

### 16. `detectStuckIssues()` — already in `pipeline.ts` from Phase 1

### 17. Smart restart — already in `agent-context.ts` from Phase 1

### 18. Human approval gates

**From pi-planner `index.ts`:**

| Pattern | Source lines | Action | Changes |
|---------|-------------|--------|---------|
| `ctx.ui.select(detail, ["Approve", "Reject", ...])` pattern (L525-535) | ~10 | STUDY | Use same `ctx.ui.select()` API. Build our own choices: "Execute plan", "Modify", "Cancel". |
| `ctx.ui.editor("feedback:", "")` for rejection feedback (L536-540) | ~5 | STUDY | Use same pattern for user feedback. |

These are API patterns, not copy-paste code. We use the same pi extension APIs.

---

## Phase 4: W4

### 19-24. Task store, feature workflow, TDD

**From pi-messenger `crew/store.ts`:**

| Function | Source lines | Action | Changes |
|----------|-------------|--------|---------|
| `readJson()`, `writeJson()`, `readText()`, `writeText()` helpers (L43-78) | 36 | COPY | Pure I/O helpers with atomic writes (temp + rename). |
| `createTask()` (L173-216) | 44 | ADAPT | Simplify: drop `base_commit`, `assigned_to`, `milestone`, `model`, `skills`. Keep: `id`, `title`, `status`, `depends_on`, `created_at`. |
| `getTask()` (L217-221) | 5 | COPY | |
| `updateTask()` (L222-235) | 14 | COPY | |
| `getTasks()` (L236-254) | 19 | COPY | |
| `getReadyTasks()` (L449-465) | 17 | ADAPT | Drop `advisory` mode. Keep dependency resolution: filter tasks whose `depends_on` are all `"done"`. |
| `startTask()` (L329-341) | 13 | ADAPT | Drop `base_commit`, `assigned_to`. |
| `completeTask()` (L342-371) | 30 | ADAPT | Drop `evidence`. Keep status transition + completion summary. |
| `blockTask()` (L372-386) | 15 | COPY | |
| `resetTask()` (L399-448) | 50 | ADAPT | Drop `cascade` for v1. Simple reset to `"todo"`. |

**From pi-messenger `crew/task-actions.ts`:**

Not needed separately — the store functions above include the state transitions.

### 25. Parallel execution

No code to copy — the existing `run_in_background: true` + group join handles this.

### 26. Dashboard

**From pi-coordination `coordinate/render-utils.ts`:**

| Function | Source lines | Action | Changes |
|----------|-------------|--------|---------|
| `renderPipelineRow()` (L153-204) | 52 | ADAPT | Use our phase names. Same rendering pattern: phase name + status icon + connector. |
| `renderCostBreakdown()` (L205-235) | 31 | ADAPT | Use our phase names. |

**From pi-coordination `coordinate/dashboard.ts` — STUDY ONLY:**

The full dashboard (1524 lines) is too much. Study the `MiniFooter` class pattern (~50 lines) for our `/flow` command. Build our own simplified version.

---

## Summary: Lines to Copy vs Adapt vs New

| Category | Lines | Files |
|----------|-------|-------|
| **Direct copy** (zero changes) | ~280 | `truncate.ts` (121), `verdict.ts` (55), `detectStuckIssues` (19), pure helpers from render-utils (~45), `isRecoverableExit` (15), I/O helpers (36) |
| **Adapt** (same logic, renamed/simplified) | ~650 | types (150), pipeline engine (250), agent-context (150), tool-guard (50), stalled (40), task-store (partial) |
| **New** (not in any repo) | ~700 | router, handoff protocol, workflow implementations (W1-W4), TDD verification, widget rendering |
| **Study** (use as reference, write our own) | — | dashboard, approval gates, interview pattern, wave execution |

**Total estimate: ~1,630 lines of new workflow code across all 4 phases.**
