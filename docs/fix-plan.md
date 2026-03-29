# Fix Plan — AGENTS.md Compliance

All issues from the code evaluation, organized into commits.

---

## Phase 1: Config & Tooling (no source changes)

### Commit 1: Fix tsconfig strict flags
- **tsconfig.json**: add `noUncheckedIndexedAccess: true` and `exactOptionalPropertyTypes: true`
- Fix any type errors these flags surface (expect many from indexed access returning `T | undefined`)

### Commit 2: Add `"type": "module"` to package.json
- `npm pkg set type=module`
- Verify `npm run check` still passes

### Commit 3: Enable `noExplicitAny` in Biome
- **biome.json**: change `"noExplicitAny": "off"` → `"noExplicitAny": "error"`
- Do NOT fix violations yet — just enable the rule and verify it reports them

---

## Phase 2: Eliminate `any` (file by file, smallest first)

Each commit: fix all `any` in one file → run `npm run check` → commit.

### Commit 4: `src/context.ts` (2 instances)
- Lines 10-11: `(c: any)` → type-narrow `unknown` content blocks

### Commit 5: `src/cross-extension-rpc.ts` (3 instances)
- Line 28: `options: any` → `options: unknown` or a typed interface
- Line 61: `catch (err: any)` → `catch (err: unknown)` + narrowing
- Line 80: `options?: any` → `options?: unknown`

### Commit 6: `src/model-resolver.ts` (4 instances)
- Lines 12-14: registry interface methods return `any` → proper `ModelEntry` or `unknown`
- Line 25: return type `any | string` → proper union or generic

### Commit 7: `src/agent-types.ts` (4 instances)
- Line 21: `ToolFactory` returns `AgentTool<any>` → use generic or `AgentTool<unknown>`
- Lines 119, 132, 139: return types `AgentTool<any>[]` → `AgentTool<unknown>[]`

### Commit 8: `src/agent-runner.ts` (6 instances)
- Lines 54-57, 67, 89: `Model<any>` → proper generic or `Model<unknown>`
- Line 427: `(c as any).name` → type-narrow the content block

### Commit 9: `src/agent-manager.ts` (1 instance)
- Line 32: `model?: Model<any>` → `Model<unknown>`

### Commit 10: `src/ui/agent-widget.ts` (3 instances)
- Lines 46, 174, 270: `tui: any` → proper TUI type from `@mariozechner/pi-tui`

### Commit 11: `src/ui/conversation-viewer.ts` (3 instances)
- Lines 194, 216-217: `as any` casts → type-narrow message types

### Commit 12: `src/index.ts` (~12 instances)
- Line 48: `details as any` → proper type
- Lines 85, 810, 906: `session: any` → typed session
- Line 153: `session?: any` in record → typed
- Lines 416, 419, 452: `globalThis as any` → typed global registry
- Line 553: `registerTool<any, ...>` → proper generic
- Line 898: `details as any` → proper type

---

## Phase 3: Remove unsafe `as Type` casts

### Commit 13: Replace `as Type` casts with runtime validation
- `src/cross-extension-rpc.ts:55` — `raw as P` → validate or narrow
- `src/model-resolver.ts:27` — `as ModelEntry[]` → validate shape
- `src/index.ts:730` — `as SubagentType` → validate against known types
- `src/index.ts:1660` — `as JoinMode` → validate against known modes
- `src/invocation-config.ts:29` — `as ThinkingLevel` → validate
- `src/custom-agents.ts:63` — `as ThinkingLevel` → validate
- `src/agent-runner.ts:268` — `as Parameters<...>[0]` → restructure to avoid

---

## Phase 4: Function signature cleanup

### Commit 14: Convert 3+ positional args to object params
Files with violations:
- `src/output-file.ts:15` — `createOutputFilePath(cwd, agentId, sessionId)` → object
- `src/output-file.ts:26` — `writeInitialEntry(path, agentId, prompt, cwd)` → object
- `src/memory.ts:56` — `resolveMemoryDir(agentName, scope, cwd)` → object
- `src/memory.ts:109` — `buildMemoryBlock(agentName, scope, cwd)` → object
- `src/memory.ts:151` — `buildReadOnlyMemoryBlock(agentName, scope, cwd)` → object
- `src/custom-agents.ts:32` — `loadFromDir(dir, agents, source)` → object
- Update all call sites for each changed function

---

## Phase 5: Colocate tests

### Commit 15: Move `test/*.test.ts` → `src/*.test.ts`
- Move every file from `test/` to sit next to its source in `src/`
- e.g. `test/memory.test.ts` → `src/memory.test.ts`
- Update any import paths in test files
- Delete empty `test/` directory
- Verify `npm run check` passes (vitest autodiscovers)

---

## Phase 6: Split oversized files (largest first)

### Commit 16: Split `src/index.ts` (1,671 lines → ~8 files)
Proposed split:
| New file | Responsibility | Est. lines |
|----------|---------------|------------|
| `src/index.ts` | Extension entry point, `export default`, tool/command registration | ~150 |
| `src/tools/agent-tool.ts` | `Agent` tool definition + execute logic | ~200 |
| `src/tools/get-result-tool.ts` | `get_subagent_result` tool | ~100 |
| `src/tools/steer-tool.ts` | `steer_subagent` tool | ~80 |
| `src/commands/agents-command.ts` | `/agents` interactive menu | ~200 |
| `src/commands/settings.ts` | Settings submenu logic | ~150 |
| `src/lifecycle.ts` | Agent spawn/run/complete orchestration, callbacks | ~200 |
| `src/notifications.ts` | Notification/nudge helpers (`buildNotificationDetails`, `scheduleNudge`) | ~100 |
| `src/global-registry.ts` | `globalThis` manager singleton (Symbol-based) | ~50 |

### Commit 17: Split `src/ui/agent-widget.ts` (488 lines → ~3 files)
| New file | Responsibility | Est. lines |
|----------|---------------|------------|
| `src/ui/agent-widget.ts` | `AgentWidget` class | ~200 |
| `src/ui/formatters.ts` | `formatTokens`, `formatMs`, `formatDuration`, `formatTurns` | ~50 |
| `src/ui/display-helpers.ts` | `getDisplayName`, `getPromptModeLabel`, `describeActivity`, `SPINNER` | ~80 |

### Commit 18: Split `src/agent-runner.ts` (439 lines → ~2 files)
| New file | Responsibility | Est. lines |
|----------|---------------|------------|
| `src/agent-runner.ts` | `runAgent`, `resumeAgent`, `steerAgent`, config | ~200 |
| `src/agent-session.ts` | Session creation, conversation extraction, model resolution for agents | ~200 |

### Commit 19: Split `src/agent-manager.ts` (409 lines → ~2 files)
| New file | Responsibility | Est. lines |
|----------|---------------|------------|
| `src/agent-manager.ts` | `AgentManager` class — queue, lifecycle | ~200 |
| `src/agent-concurrency.ts` | Concurrency control, slot management, queue scheduling | ~200 |

### Commit 20: Split `src/ui/conversation-viewer.ts` (243 lines) + test (323 lines)
| New file | Responsibility | Est. lines |
|----------|---------------|------------|
| `src/ui/conversation-viewer.ts` | Main viewer class | ~150 |
| `src/ui/message-renderer.ts` | Message-to-lines rendering logic | ~100 |
| Split test accordingly |

---

## Phase 7: Add missing tests

### Commit 21+: Write tests for uncovered files
Priority by complexity:
1. `src/context.ts` — pure functions, easy to test
2. `src/output-file.ts` — file I/O, needs fs mocking
3. `src/group-join.ts` — stateful but testable
4. `src/default-agents.ts` — config/data, may be trivial
5. `src/types.ts` — likely just types, may not need tests
6. New files from Phase 6 splits — test as they're created

---

## Execution Order Summary

| Phase | Commits | Risk | Notes |
|-------|---------|------|-------|
| 1. Config | 1-3 | 🔴 High | Strict flags will surface many type errors |
| 2. Eliminate `any` | 4-12 | 🟡 Medium | File by file, smallest first |
| 3. Remove `as` casts | 13 | 🟡 Medium | Runtime validation needed |
| 4. Function signatures | 14 | 🟢 Low | Mechanical refactor |
| 5. Colocate tests | 15 | 🟢 Low | Move files, fix imports |
| 6. Split files | 16-20 | 🔴 High | Largest refactor, most risk |
| 7. Missing tests | 21+ | 🟢 Low | Additive only |

**Total: ~21 commits, phases can be done independently.**
