# Purity Refactor Plan

Push side effects to the edges, make the core pure. Same external behavior.

---

## Commit 1: Pure formatters — remove `getConfig` dependency

**Files:** `ui/formatters.ts`, `ui/widget.ts`, `ui/viewer.ts`, `extension/command.ts`, `index.ts`

**Problem:** `getDisplayName(type)` and `getPromptModeLabel(type)` call `getConfig(type)` which reads the global `agents` Map. This makes them impure despite being simple string formatters.

**Fix:** Change signatures to receive the values directly:
```ts
// Before (impure — reads global state)
getDisplayName(type: SubagentType)        // calls getConfig(type) internally
getPromptModeLabel(type: SubagentType)    // calls getConfig(type) internally

// After (pure — no hidden dependencies)
getDisplayName(type: SubagentType, displayName?: string)   // uses displayName ?? type
getPromptModeLabel(promptMode: "replace" | "append")       // returns "append" or undefined
```

**Call site changes:** Every caller already has the config or can get the display name. ~12 call sites to update. `formatters.ts` drops the `registry.js` import entirely.

**Tests:** Existing formatter tests pass (they test output, not wiring).

---

## Commit 2: Settings object — replace module-level `let` vars

**Files:** `agents/runner.ts`, `extension/command.ts`, `index.ts`

**Problem:** `defaultMaxTurns` and `graceTurns` are module-level `let` variables with getter/setter pairs. Global mutable state.

**Fix:** Create a `RunnerSettings` object passed through instead of accessed globally:
```ts
// Before (global mutable state)
let defaultMaxTurns: number | undefined;
let graceTurns = 5;
export function getDefaultMaxTurns() { return defaultMaxTurns; }
export function setDefaultMaxTurns(n) { defaultMaxTurns = normalizeMaxTurns(n); }

// After (explicit object, created once in index.ts, passed to consumers)
export function createRunnerSettings() {
  return {
    defaultMaxTurns: undefined as number | undefined,
    graceTurns: 5,
  };
}
```

**Call site changes:**
- `index.ts` creates the settings object, passes to `command.ts` via deps
- `runAgent` receives `maxTurns` already resolved — no change needed
- `command.ts` reads/writes settings via the deps object (already has deps pattern)
- `normalizeMaxTurns` stays pure — no change

---

## Commit 3: Extract duplicated cleanup in `AgentManager.startAgent`

**Files:** `agents/manager.ts`

**Problem:** `.then()` and `.catch()` handlers in `startAgent` share ~20 lines of identical cleanup:
- Flush output file
- Cleanup worktree
- Decrement background counter
- Notify `onComplete`
- Drain queue

**Fix:** Extract a `finalizeAgent` private method:
```ts
private finalizeAgent(record, ctx, options, error?: Error) {
  if (record.status !== "stopped") {
    record.status = error ? "error" : /* from result */ ;
  }
  record.completedAt ??= Date.now();
  // flush output, cleanup worktree, decrement counter, notify, drain
}
```

Both `.then()` and `.catch()` call `finalizeAgent` with different inputs. ~20 duplicated lines → 1 call each.

---

## Commit 4: Split `buildMemoryBlock` — separate I/O from string building

**Files:** `infra/memory.ts`, `agents/runner.ts`

**Problem:** `buildMemoryBlock` mixes I/O (creates directories, reads files) with pure string building.

**Fix:** Split into two functions:
```ts
// Pure — builds the prompt string from already-read data
export function buildMemoryPrompt({ memoryDir, scope, existingMemory }: {
  memoryDir: string;
  scope: MemoryScope;
  existingMemory: string | undefined;
}) { ... }

// I/O — reads state, delegates to pure builder
export function buildMemoryBlock({ agentName, scope, cwd }: { ... }) {
  const memoryDir = resolveMemoryDir({ agentName, scope, cwd });
  ensureMemoryDir(memoryDir);
  const existingMemory = readMemoryIndex(memoryDir);
  return buildMemoryPrompt({ memoryDir, scope, existingMemory });
}
```

Same split for `buildReadOnlyMemoryBlock` → `buildReadOnlyMemoryPrompt` (same pattern, read state then delegate to pure builder).

**Value:** The pure prompt builders are trivially testable without filesystem mocks. Existing tests that use temp dirs still work through the wrapper.

---

## Commit 5: `GroupJoinManager` → functions + state object

**Files:** `extension/group-join.ts`, `index.ts`

**Problem:** `GroupJoinManager` is a class with 2 Maps and timeout handles. All methods just manipulate those Maps.

**Fix:** Replace with a state object + pure functions + one impure edge function:
```ts
// State
export interface GroupJoinState {
  groups: Map<string, AgentGroup>;
  agentToGroup: Map<string, string>;
}

// Pure
export function createGroupJoinState(): GroupJoinState { ... }
export function onAgentComplete(state: GroupJoinState, record: AgentRecord): 
  { action: 'pass' } | { action: 'held' } | { action: 'deliver'; records: AgentRecord[]; partial: boolean }

// Impure edge (handles setTimeout)
export function createGroupJoinManager(deliverCb, groupTimeout?) {
  const state = createGroupJoinState();
  return {
    registerGroup: (groupId, agentIds) => registerGroup(state, groupId, agentIds),
    onAgentComplete: (record) => {
      const result = onAgentComplete(state, record);
      if (result.action === 'deliver') deliverCb(result.records, result.partial);
      // handle timeout scheduling
      return result.action;
    },
    isGrouped: (id) => state.agentToGroup.has(id),
    dispose: () => { /* clear timeouts */ },
  };
}
```

**Key insight:** `onAgentComplete` becomes pure — it returns what _should_ happen. The impure shell decides _when_ to deliver (timeout vs immediate). The timeout logic stays in the shell.

**Call sites:** `index.ts` uses the same API shape (factory function returns object with same methods). Drop-in replacement.

---

## Commit 6: `AgentWidget` — pure render functions, thin class shell

**Files:** `ui/widget.ts`

**Problem:** `AgentWidget` is 358 lines. The `renderWidget` (100+ lines) and `renderFinishedLine` methods mix state access with string building.

**Fix:** Extract pure render functions that take data in, return strings out:
```ts
// Pure — takes data, returns lines
export function renderAgentWidget({ running, queued, finished, frame, columns }: {
  running: RunningAgentData[];
  queued: number;
  finished: FinishedAgentData[];
  frame: number;
  columns: number;
}) { ... }

export function renderFinishedLine(agent: FinishedAgentData, theme: Theme) { ... }
```

The class becomes a thin shell:
- Collects data from `manager.listAgents()` + `agentActivity`
- Calls pure render functions
- Manages the widget lifecycle (register/unregister, timer, status bar)

**Value:** The 100+ line render function becomes independently testable without mocking TUI, AgentManager, or timers.

---

## Commit 7: `ConversationViewer` — pure `buildContentLines`

**Files:** `ui/viewer.ts`

**Problem:** `buildContentLines` (80+ lines) is a private method that only reads `this.session.messages` and `this.activity`. It's already almost pure — just needs the `this` references removed.

**Fix:** Extract as a standalone pure function:
```ts
export function buildConversationLines({ messages, activity, status, width, theme }: {
  messages: AgentMessage[];
  activity: AgentActivity | undefined;
  status: string;
  width: number;
  theme: Theme;
}) { ... }
```

The class keeps `handleInput`, `render`, `dispose` (required by `Component` interface) but delegates content building to the pure function.

---

## Commit 8: Injectable registry — pass as parameter instead of global

**Files:** `agents/registry.ts`, `agents/runner.ts`, `ui/formatters.ts`, `extension/command.ts`, `index.ts`

**Problem:** `registry.ts` has a module-level `const agents = new Map()` that 12 exported functions read/write. All consumers import and call these functions, creating a hidden dependency on global mutable state.

**Fix:** Change registry to a factory that returns an object:
```ts
export function createRegistry() {
  const agents = new Map<string, AgentConfig>();
  return {
    register: (userAgents: Map<string, AgentConfig>) => { ... },
    getConfig: (name: string) => { ... },
    getAvailableTypes: () => { ... },
    getAllTypes: () => { ... },
    // ... all current exported functions, but operating on the local Map
  };
}
export type Registry = ReturnType<typeof createRegistry>;
```

**Call site changes:**
- `index.ts` creates the registry once: `const registry = createRegistry()`
- Pass to `runner.ts`, `command.ts` via existing deps patterns
- `formatters.ts` no longer imports registry at all (commit 1 already removed it)
- `BUILTIN_TOOL_NAMES` and `TOOL_FACTORIES` stay module-level constants (they're immutable)

**Side effect:** `resolveDefaultModel` in `runner.ts` calls `registry.find()` / `registry.getAvailable()`. With the registry passed as a parameter to `runAgent`, this becomes explicit — no hidden global read.

**This is the highest-effort commit** — touches the most files. But the deps/factory patterns already exist from `registerAgentsCommand` and `runAgent`, so the plumbing is established.

---

## Commit 9: `createActivityTracker` — pure state updaters + impure shell

**Files:** `extension/helpers.ts`, `index.ts`

**Problem:** `createActivityTracker` creates a mutable `AgentActivity` state object and returns closures that mutate it. The callbacks mix state mutation with side effects (`onStreamUpdate`, `safeFormatTokens`).

**Fix:** Extract pure state update functions, keep the factory as the impure shell:
```ts
// Pure — returns updated state fields for a tool activity event
export function applyToolActivity(state: AgentActivity, activity: { type: "start" | "end"; toolName: string }) {
  // returns new activeTools Map, updated toolUses count
}

// Pure — returns updated state for text delta
export function applyTextDelta(state: AgentActivity, fullText: string) {
  // returns { responseText: fullText }
}

// Impure shell — same API, but delegates to pure updaters
export function createActivityTracker(maxTurns?, onStreamUpdate?) {
  const state: AgentActivity = { ... };
  return {
    state,
    callbacks: {
      onToolActivity: (activity) => {
        Object.assign(state, applyToolActivity(state, activity));
        state.tokens = safeFormatTokens(state.session);
        onStreamUpdate?.();
      },
      // ...
    },
  };
}
```

**Value:** The pure updaters (`applyToolActivity`, `applyTextDelta`) are testable without mocking sessions or callbacks. The factory keeps working identically.

---

## Execution Order

| Commit | Risk | Files | Why this order |
|--------|------|-------|----------------|
| 1. Pure formatters | 🟢 Low | 5 | Zero coupling — clears path for commit 8 |
| 2. Settings object | 🟢 Low | 3 | Small, self-contained |
| 3. Extract cleanup | 🟢 Low | 1 | Single file, DRY |
| 4. Split memory I/O | 🟢 Low | 2 | Small, additive (both `buildMemoryBlock` and `buildReadOnlyMemoryBlock`) |
| 5. GroupJoin → functional | 🟡 Medium | 2 | Timeout logic needs care |
| 6. Widget pure render | 🟡 Medium | 1 | Large but isolated |
| 7. Viewer pure content | 🟢 Low | 1 | Small extraction |
| 8. Injectable registry | 🟡 Medium | 5+ | Most files touched, also fixes `resolveDefaultModel` impurity |
| 9. Activity tracker | 🟢 Low | 2 | Extract pure state updaters from `createActivityTracker` |

**Total: 9 commits. Each independently shippable. Tests pass after every commit.**
