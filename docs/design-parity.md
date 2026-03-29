# Design: Full Feature Parity with tintinweb/pi-subagents

**Status**: Complete — 93/93 gaps addressed  
**Branch**: `feature/parity`  
**Gaps**: 93 identified, 93 addressed, 0 remaining  

## Principles

1. **Preserve pi-flow's workflow specialization** — TDD gates, coordinator prompt, artifacts, budget tracking stay intact
2. **Adopt tintinweb's runtime capabilities** — don't water down, match the real behavior
3. **TDD for every phase** — tests first, implementation second
4. **Incremental commits** — each phase is a separate commit with all tests green

---

## Phase 1: Foundation Fixes (bugs + missing wiring)

Gaps: **#24, #26, #41**

| # | Gap | Fix |
|---|-----|-----|
| 24 | Pending steers never flushed | Add `onSessionCreated` to `RunAgentOptions`, wire it in `runAgent()`, flush `record.pendingSteers` in `background.ts` |
| 26 | `waitForAll()` misses queue drain | Loop: drain → await running → repeat until empty |
| 41 | `GroupJoinManager` exists but never wired | Wire into `BackgroundManager.onComplete` in `index.ts`; register groups for parallel background dispatches in `dispatch.ts` |

**Files**: `runner.ts`, `background.ts`, `dispatch.ts`, `index.ts`  
**Est**: ~80 lines src, ~60 lines test

---

## Phase 2: Manager Record Enrichment

Gaps: **#28, #29, #30, #31, #32, #33, #34, #35, #36, #37, #27**

Expand `BackgroundRecord` with all tintinweb fields:

| # | Field | Purpose |
|---|-------|---------|
| 28 | `session?: AgentSession` | Enables resume, conversation viewing, live stats |
| 29 | Auto-cleanup interval | 10-min GC of completed records |
| 30 | `toolUses: number` | Counter incremented via callback |
| 31 | `onStart` callback | Fires when agent transitions from queued → running |
| 32 | `toolCallId?: string` | Correlates with original tool call |
| 33 | `outputFile?` + `outputCleanup?` | Streaming transcript file |
| 34 | `resultConsumed?: boolean` | Suppresses completion notification |
| 35 | `groupId?` + `joinMode?` | Group join metadata |
| 36 | `worktree?` + `worktreeResult?` | Worktree info on record (move from runner) |
| 37 | `dispose()` prunes worktrees | Crash recovery |
| 27 | `setMaxConcurrent(n)` | Runtime concurrency change |

**Files**: `background.ts`, `types.ts`  
**Est**: ~100 lines src, ~80 lines test

---

## Phase 3: Agent Config Enrichment

Gaps: **#60, #62, #63, #64, #65, #66, #67, #68, #69, #70, #72, #112, #113, #114**

New fields in `FlowAgentConfig`:

| # | Field | Type | Default |
|---|-------|------|---------|
| 60 | `enabled` | `boolean` | `true` |
| 62 | `disallowedTools` | `string[]` | `[]` |
| 63 | `inheritContext` | `boolean` | `false` |
| 64 | `runInBackground` | `boolean` | `false` |
| 65 | `isolated` | `boolean` | `false` |
| 66 | `extensions` | `true \| string[] \| false` | `false` |
| 67 | `skills` | `true \| string[] \| false` | `false` |
| 68 | `promptMode` | `'replace' \| 'append'` | `'replace'` |
| 112 | Memory scope `'local'` | Added to `MemoryScope` | — |

Also:
- **#69**: Global agent dir (`~/.pi/flow-agents/*.md`)
- **#70**: Case-insensitive agent name resolution
- **#72**: Hot-reload custom agents on each dispatch
- **#113**: Memory tool injection (add read/write/edit if agent lacks them)
- **#114**: Write-capability detection based on actual tool set + denylist

**Files**: `types.ts`, `agents.ts`, `memory.ts`  
**Est**: ~150 lines src, ~120 lines test

---

## Phase 4: Runner Enhancements

Gaps: **#3, #4, #5, #8, #9, #10, #11, #12, #14, #15, #16, #17, #20, #106, #107, #109, #116, #117**

### 4a: Configurable limits (#3, #4, #5)
- Export `setGraceTurns(n)`, `getGraceTurns()`, `setDefaultMaxTurns(n)`, `getDefaultMaxTurns()`
- `normalizeMaxTurns()`: 0/undefined → unlimited

### 4b: Environment block (#14, #106, #107, #109)
- `detectEnv()` → `{ isGitRepo, branch, platform }`  
- Build `# Environment` block and `<sub_agent_context>` for every agent prompt
- Use `pi.exec()` for async git detection (#15)

### 4c: Tool factories + denylist (#10, #20, #117)
- `createReadTool(cwd)` etc. instead of global singletons
- Apply `disallowedTools` filter after `setActiveToolsByName()`

### 4d: Extension/skill inheritance (#8, #9, #11, #66, #67)
- When `agent.extensions !== false`: load extensions via `DefaultResourceLoader`
- When `agent.skills` is `string[]`: `preloadSkills()` into prompt
- `session.bindExtensions()` when extensions enabled

### 4e: Prompt mode (#12, #68)
- `append`: env header + parent system prompt + `<sub_agent_context>` + `<agent_instructions>`
- `replace`: env header + agent systemPrompt (current behavior)

### 4f: Session callback + worktree warning (#16, #116)
- `onSessionCreated` callback in `RunAgentOptions`
- Prepend warning when worktree creation fails

### 4g: SettingsManager (#17)
- Use `SettingsManager.create()` instead of `.inMemory()`

**Files**: `runner.ts`, `env.ts` (new), `skill-loader.ts` (new), `prompts.ts` (new)  
**Est**: ~300 lines src, ~200 lines test

---

## Phase 5: Notification System

Gaps: **#40, #43, #44, #45, #46, #47, #48**

| # | Feature | Implementation |
|---|---------|---------------|
| 40 | Smart batch detection | 100ms debounce timer in `index.ts`; auto-registers groups |
| 43 | Cancellable pending nudges | `scheduleNudge(key, send, 200ms)` + `cancelNudge(key)` |
| 44 | `resultConsumed` suppression | Set flag in `get_agent_result` before await; check in `onComplete` |
| 45 | Custom message renderer | `pi.registerMessageRenderer("flow-notification", ...)` |
| 46 | XML `<task-notification>` format | `formatTaskNotification()` helper |
| 47 | Group notification | First agent as primary, rest as `others` in details |
| 48 | Output file in notifications | Include `outputFile` path |

**Files**: `index.ts`, `notification.ts` (new)  
**Est**: ~200 lines src, ~100 lines test

---

## Phase 6: Advanced Execution

Gaps: **#6, #7, #19, #25, #85, #88**

| # | Feature | Implementation |
|---|---------|---------------|
| 6+25+88 | Resume existing session | `resume()` on `BackgroundManager`; `resumeAgent()` in runner; `resume` param on `dispatch_flow` |
| 7+85 | Parent context forking | `buildParentContext(ctx)` from session branch; `inherit_context` param on `dispatch_flow` |
| 19 | `getAgentConversation()` | Format session messages as readable transcript |

**Files**: `runner.ts`, `context.ts` (new), `background.ts`, `dispatch.ts`, `index.ts`  
**Est**: ~150 lines src, ~120 lines test

---

## Phase 7: Model Resolution

Gaps: **#73, #74, #75, #76, #82**

| # | Feature | Implementation |
|---|---------|---------------|
| 73 | Fuzzy matching | `resolveModel()` with scored matching (exact > substring > name > parts) |
| 74 | Available model check | Filter to `registry.getAvailable()` |
| 75 | Error message with list | Return model list on failure |
| 76+82 | Per-invocation `model` param | `model` param on `dispatch_flow` |

**Files**: `model-resolver.ts` (new), `runner.ts`, `dispatch.ts`, `index.ts`  
**Est**: ~120 lines src, ~80 lines test

---

## Phase 8: Output Transcript

Gaps: **#77, #78, #79, #80, #81**

| # | Feature | Implementation |
|---|---------|---------------|
| 77+78+79 | Streaming JSONL output | `output-file.ts`: `createOutputFilePath()`, `writeInitialEntry()`, `streamToOutputFile()` |
| 80 | Output file on record + notification | Wire to `BackgroundRecord.outputFile` |
| 81 | `verbose` flag on `get_agent_result` | Include full conversation via `getAgentConversation()` |

**Files**: `output-file.ts` (new), `background.ts`, `index.ts`  
**Est**: ~100 lines src, ~60 lines test

---

## Phase 9: Tool Parameters

Gaps: **#83, #84, #85, #86, #87**

Add to `dispatch_flow` parameters (some already addressed in earlier phases):

| # | Param | Type | Passed to |
|---|-------|------|-----------|
| 83 | `thinking` | `string` | `runAgent()` → session thinkingLevel |
| 84 | `max_turns` | `number` | `runAgent()` → turn limit |
| 86 | `isolated` | `boolean` | `runAgent()` → noExtensions override |
| 87 | `isolation` | `"worktree"` | `runAgent()` → worktree override |

**Files**: `types.ts`, `dispatch.ts`, `runner.ts`, `index.ts`  
**Est**: ~60 lines src, ~40 lines test

---

## Phase 10: UI & Widget

Gaps: **#49, #50, #51, #52, #53, #54, #55, #56, #57, #105**

### 10a: Live widget (#49-55, #57)
- `agent-widget.ts` (new): `FlowAgentWidget` class
- Braille spinner (80ms, 10 frames)
- Activity description from active tools
- Live token count from session stats
- Turn count display (`⟳5≤30`)
- Finished agent linger (1 turn normal, 2 turns errors)
- Overflow collapse (max 12 lines)
- Status bar updates (`"2 running, 1 queued"`)

### 10b: Conversation viewer (#56, #105)
- `conversation-viewer.ts` (new): `FlowConversationViewer` class
- Scrollable, live-updating overlay
- Wire to `/flow agents` command

**Files**: `ui/agent-widget.ts` (new), `ui/conversation-viewer.ts` (new), `index.ts`  
**Est**: ~600 lines src, ~100 lines test

---

## Phase 11: Commands & Cross-Extension

Gaps: **#90, #91, #92, #93, #94, #95, #96, #97, #98, #99, #100, #101, #102, #103, #104**

### 11a: Cross-extension (#90-94)
- `cross-extension-rpc.ts` (new): ping/spawn/stop RPC handlers
- `Symbol.for("pi-flow:manager")` global registry
- Lifecycle events: `flow:created`, `flow:started`, `flow:completed`, `flow:failed`
- `pi.appendEntry("flow:record", ...)` for history
- `session_switch` event handling

### 11b: Interactive /flow menu (#95-105)
- Expand `/flow` command into interactive menu:
  - Running agents (status, duration, tool count → conversation viewer)
  - Agent types (list, detail, enable/disable)
  - Create agent wizard
  - Edit agent (in-TUI markdown editor)
  - Eject default → .md, reset to default, delete
  - Settings (max_concurrent, default_max_turns, grace_turns, join_mode)

**Files**: `cross-extension-rpc.ts` (new), `index.ts`  
**Est**: ~400 lines src, ~80 lines test

---

## Dependency Graph

```
Phase 1 (Foundation) ─────┐
                          ├─→ Phase 2 (Manager Records)
Phase 3 (Agent Config) ───┤
                          ├─→ Phase 4 (Runner Enhancements)
                          │     ├─→ Phase 5 (Notifications)
                          │     ├─→ Phase 6 (Advanced Execution)
                          │     ├─→ Phase 7 (Model Resolution)
                          │     ├─→ Phase 8 (Output Transcript)
                          │     └─→ Phase 9 (Tool Parameters)
                          │
                          └─→ Phase 10 (UI/Widget) ─→ Phase 11 (Commands/Cross-Ext)
```

Phases 1-4 are sequential prerequisites.  
Phases 5-9 can proceed in any order after Phase 4.  
Phases 10-11 depend on Phase 2 (manager records) and Phase 4 (runner).

---

## Estimated Total

| Phase | Src Lines | Test Lines | New Files |
|-------|-----------|------------|-----------|
| 1. Foundation | ~80 | ~60 | 0 |
| 2. Manager Records | ~100 | ~80 | 0 |
| 3. Agent Config | ~150 | ~120 | 0 |
| 4. Runner Enhancements | ~300 | ~200 | 3 (env, skill-loader, prompts) |
| 5. Notifications | ~200 | ~100 | 1 (notification.ts) |
| 6. Advanced Execution | ~150 | ~120 | 1 (context.ts) |
| 7. Model Resolution | ~120 | ~80 | 1 (model-resolver.ts) |
| 8. Output Transcript | ~100 | ~60 | 1 (output-file.ts) |
| 9. Tool Parameters | ~60 | ~40 | 0 |
| 10. UI/Widget | ~600 | ~100 | 2 (agent-widget, conversation-viewer) |
| 11. Commands/Cross-Ext | ~400 | ~80 | 1 (cross-extension-rpc.ts) |
| **Total** | **~2,260** | **~1,040** | **10** |

Post-parity stats (projected):
- Source files: 17 → 27
- Source lines: 4,782 → ~7,042
- Test lines: 4,753 → ~5,793
- Tests: 391 → ~500+
