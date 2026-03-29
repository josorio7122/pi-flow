# Design: In-Process Agent Execution

## Status

**Proposal** — ready for review.

## Problem

pi-flow currently spawns `pi` CLI subprocesses to run agents. This introduces:

- **Process management overhead** — spawn, IPC, orphan cleanup
- **No mid-run steering** — can't redirect a running agent
- **No session resume** — can't continue a previous agent's conversation
- **No real-time stats** — usage/tokens parsed from NDJSON, not live
- **File-based IPC** — temp prompt files, NDJSON stdout parsing
- **Fragile abort** — SIGTERM → 5s → SIGKILL instead of clean `session.abort()`
- **No dynamic tool filtering** — tools fixed at spawn via `--tools` CLI flag
- **Retry logic needed** — lock file contention, missing API keys on cold start

tintinweb/pi-subagents solves all of these by using pi's `createAgentSession()` SDK
to run agents in-process. pi-flow should adopt this approach.

## Goal

Replace subprocess execution (`spawn.ts`) with in-process execution via
`createAgentSession()`, while preserving every existing pi-flow feature:

- All 3 dispatch modes (single, parallel, chain)
- Agent discovery, validation, variable injection
- Feature-scoped state (artifacts, checkpoints, dispatch logs)
- Session-scoped state (findings, session dispatch logs)
- Coordinator tool blocking (write restriction to `.flow/`)
- Loop detection
- Budget tracking
- Live progress rendering (agent cards with tool activity)
- Concurrency-limited parallel execution

And gaining new capabilities:

- Mid-run steering (coordinator can redirect agents)
- Graceful turn limits (steer → grace → abort)
- Real-time token/cost tracking from `session.getSessionStats()`
- Proper in-process abort via `session.abort()`
- Dynamic tool filtering via `session.setActiveToolsByName()`
- Zero temp files — system prompt injected via `systemPromptOverride`
- No retry logic needed — no process spawn, no lock contention

## Architecture

### What changes

| File | Change | Reason |
|------|--------|--------|
| `spawn.ts` | **DELETE** | Replaced entirely by `runner.ts` |
| `runner.ts` | **NEW** | In-process execution via `createAgentSession()` |
| `dispatch.ts` | **MODIFY** | Pass `ExtensionContext` to runner; call `runAgent` instead of `spawnAgentWithRetry` |
| `index.ts` | **MODIFY** | Pass `ctx` through to `executeDispatch` |
| `types.ts` | **MODIFY** | New types for in-process execution; remove subprocess-specific fields |

### What stays unchanged

| File | Why |
|------|-----|
| `agents.ts` | Agent discovery, parsing, variable injection — all filesystem, no execution |
| `artifacts.ts` | Writes agent output to feature dir — input is a string, not a process |
| `config.ts` | Reads config.yaml — no execution dependency |
| `guardrails.ts` | Loop detection — operates on tool_call events, not processes |
| `tool-blocking.ts` | Coordinator write restriction — tool_call event hook |
| `skills.ts` | Skill discovery — filesystem only |
| `state.ts` | Feature/session state — filesystem only |
| `prompt.ts` | Coordinator prompt builder — string manipulation |
| `rendering.ts` | TUI rendering — consumes `SingleAgentResult`, not processes |

### What moves

Pure utility functions from `spawn.ts` that don't touch processes move to
`rendering.ts` or a new `result-utils.ts`:

- `getFinalOutput()` — used by rendering and dispatch
- `getDisplayItems()` — used by rendering
- `aggregateUsage()` — used by rendering
- `emptyUsage()` / `emptyResult()` — factory helpers
- `mapWithConcurrencyLimit()` — used by dispatch

---

## Detailed Design

### 1. `runner.ts` — the new execution engine

This replaces all of `spawn.ts`. One file, one responsibility: run an agent
in-process and return a `SingleAgentResult`.

```
runner.ts exports:
  - runAgent(options: RunAgentOptions): Promise<SingleAgentResult>
  - RunAgentOptions (type)
  - RunAgentCallbacks (type)
```

#### Core flow

```
runAgent(options)
  │
  ├─ 1. Build system prompt
  │    injectVariables(agent.systemPrompt, variableMap, agent.variables)
  │
  ├─ 2. Create resource loader
  │    DefaultResourceLoader({
  │      cwd,
  │      noExtensions: true,       ← always — agents can't spawn agents
  │      noSkills: true,           ← we inject skills via prompt, not loader
  │      noPromptTemplates: true,
  │      noThemes: true,
  │      systemPromptOverride: () => systemPrompt,
  │    })
  │
  ├─ 3. Resolve model
  │    ctx.modelRegistry.find(provider, modelId)
  │    ├─ found + available → use it
  │    └─ not found → fall back to ctx.model (parent model)
  │
  ├─ 4. Resolve tools
  │    Map agent.tools names to pi built-in tool factories:
  │      "read"  → readTool
  │      "write" → writeTool
  │      "edit"  → editTool
  │      "bash"  → bashTool
  │      "grep"  → grepTool
  │      "find"  → findTool
  │      "ls"    → lsTool
  │
  ├─ 5. Create agent session
  │    createAgentSession({
  │      cwd,
  │      sessionManager: SessionManager.inMemory(cwd),
  │      settingsManager: SettingsManager.create(),
  │      modelRegistry: ctx.modelRegistry,
  │      model: resolvedModel,
  │      tools: resolvedTools,
  │      resourceLoader: loader,
  │    })
  │
  ├─ 6. Configure session
  │    session.setThinkingLevel(agent.thinking)
  │    session.setActiveToolsByName(agent.tools)  ← enforce exact tool set
  │
  ├─ 7. Subscribe to events
  │    session.subscribe((event) => {
  │      turn_end        → turnCount++; check graceful limits
  │      tool_execution_start → track tool activity
  │      tool_execution_end   → track tool activity
  │      message_update  → track response text (for display)
  │    })
  │
  ├─ 8. Wire abort signal
  │    signal.addEventListener('abort', () => session.abort())
  │
  ├─ 9. Execute
  │    await session.prompt(task)
  │
  ├─ 10. Collect results
  │     Extract usage from session.getSessionStats()
  │     Extract final text from session.messages
  │     Return SingleAgentResult
  │
  └─ 11. Cleanup
       unsubscribe(); removeAbortListener()
```

#### Graceful turn limits

Adopted from tintinweb. Configurable per-agent via `limits.max_steps` in frontmatter.

```
turnCount reaches max_steps:
  → session.steer("You have reached your turn limit. Wrap up immediately.")
  → softLimitReached = true

turnCount reaches max_steps + GRACE_TURNS (default: 5):
  → session.abort()
  → aborted = true
```

The result includes `stopReason: 'steered'` or `stopReason: 'aborted'` accordingly.

#### RunAgentOptions

```typescript
interface RunAgentOptions {
  /** Extension context — provides modelRegistry, model, cwd */
  ctx: ExtensionContext;

  /** Agent configuration (from .md frontmatter) */
  agent: FlowAgentConfig;

  /** Task string to send as the prompt */
  task: string;

  /** Variable map for template injection */
  variableMap: Record<string, string>;

  /** AbortSignal for cancellation */
  signal?: AbortSignal;

  /** Streaming callbacks for live progress */
  callbacks?: RunAgentCallbacks;
}
```

#### RunAgentCallbacks

```typescript
interface RunAgentCallbacks {
  /** Called on tool start/end — for rendering tool activity */
  onToolActivity?: (activity: { type: 'start' | 'end'; toolName: string }) => void;

  /** Called on streaming text deltas — for rendering response preview */
  onTextDelta?: (delta: string, fullText: string) => void;

  /** Called at end of each turn — for rendering turn count */
  onTurnEnd?: (turnCount: number) => void;

  /** Called when usage stats change — for live budget tracking */
  onUsageUpdate?: (usage: UsageStats) => void;
}
```

### 2. `types.ts` changes

#### Remove subprocess-specific fields

```diff
 interface SingleAgentResult {
   agent: string;
   agentSource: 'builtin' | 'custom';
   task: string;
   exitCode: number;
-  messages: Record<string, unknown>[];
-  stderr: string;
+  responseText: string;          // final assistant text
+  toolCalls: ToolCallRecord[];   // tool calls for rendering
   usage: UsageStats;
   model?: string;
   stopReason?: string;
   errorMessage?: string;
   step?: number;
   startedAt?: number;
+  steered?: boolean;             // hit turn limit, wrapped up
+  aborted?: boolean;             // grace period exceeded
 }
```

The `messages` array was an artifact of NDJSON parsing — we stored raw pi
subprocess messages. With in-process execution, we extract what we need
directly from the session.

#### New ToolCallRecord

```typescript
interface ToolCallRecord {
  name: string;
  args: Record<string, unknown>;
}
```

Replaces `DisplayItem` from `spawn.ts`. Extracted from session messages
during result collection.

### 3. `dispatch.ts` changes

Minimal. The dispatch orchestration logic (single/parallel/chain routing,
feature enforcement, variable map building, artifact write-back, budget
tracking) stays identical. Only the execution call changes:

```diff
- import { spawnAgentWithRetry, mapWithConcurrencyLimit, getFinalOutput, emptyResult } from './spawn.js';
+ import { runAgent } from './runner.js';
+ import { mapWithConcurrencyLimit, emptyResult } from './result-utils.js';
```

#### executeDispatch signature change

```diff
 export async function executeDispatch(
   params: DispatchParams,
   cwd: string,
   extensionDir: string,
+  ctx: ExtensionContext,
   signal?: AbortSignal,
   onUpdate?: OnUpdateCallback,
 ): Promise<DispatchResult>
```

The `ExtensionContext` is needed to pass `ctx.modelRegistry`, `ctx.model`,
and `ctx.cwd` to `runAgent`. This is the only new dependency.

#### executeSingle change

```diff
 async function executeSingle(...) {
-  const result = await spawnAgentWithRetry(cwd, agent, task, variableMap, signal, onAgentUpdate);
+  const result = await runAgent({
+    ctx,
+    agent,
+    task,
+    variableMap,
+    signal,
+    callbacks: {
+      onToolActivity: (activity) => { ... },
+      onTurnEnd: (turn) => { ... },
+      onUsageUpdate: (usage) => { ... },
+    },
+  });
 }
```

No retry logic needed. No temp files. No NDJSON parsing.

### 4. `index.ts` changes

Pass `ctx` to `executeDispatch`:

```diff
 async execute(_, params, signal, onUpdate, ctx) {
   initSession(ctx.cwd);
   // ...
   const result = await executeDispatch(
     { ...params, feature, sessionDir },
     ctx.cwd,
     rootDir,
+    ctx,
     signal,
     onUpdate ? (partial) => onUpdate({ content: partial.content, details: partial.details }) : undefined,
   );
```

### 5. `result-utils.ts` — pure utilities extracted from spawn.ts

These functions don't change — they just move to a dedicated file since
`spawn.ts` is being deleted:

```
result-utils.ts exports:
  - emptyUsage(): UsageStats
  - emptyResult(agent, task): SingleAgentResult
  - aggregateUsage(results): UsageStats
  - mapWithConcurrencyLimit(items, limit, fn): Promise<R[]>
```

### 6. `rendering.ts` changes

The rendering functions currently consume `messages: Record<string, unknown>[]`
and use `getDisplayItems()` / `getFinalOutput()` to extract tool calls and text.

With the new `SingleAgentResult` shape (`responseText` + `toolCalls`), rendering
simplifies:

```diff
- const displayItems = getDisplayItems(result.messages);
- const finalOutput = getFinalOutput(result.messages);
+ const displayItems = result.toolCalls.map(tc => ({ type: 'toolCall' as const, ...tc }));
+ const finalOutput = result.responseText;
```

The `DisplayItem` type, `getDisplayItems()`, and `getFinalOutput()` are deleted.
The rendering functions become simpler because they no longer parse raw messages.

### 7. Model resolution

Adopted from tintinweb's pattern. Agent frontmatter specifies a model string
like `claude-sonnet-4-6`. We resolve it against the parent's model registry:

```typescript
function resolveModel(
  ctx: ExtensionContext,
  agentModel: string,
): Model<any> | undefined {
  // Try exact match: "provider/modelId"
  const slashIdx = agentModel.indexOf('/');
  if (slashIdx !== -1) {
    const provider = agentModel.slice(0, slashIdx);
    const modelId = agentModel.slice(slashIdx + 1);
    const found = ctx.modelRegistry.find(provider, modelId);
    if (found) return found;
  }

  // Try matching just the model ID portion across all providers
  const available = ctx.modelRegistry.getAvailable();
  for (const m of available) {
    if (m.id === agentModel || m.id.includes(agentModel)) return m;
  }

  // Fall back to parent model
  return ctx.model;
}
```

This is strictly better than the CLI `--model` flag because:
- It validates the model exists and has an API key before execution
- It falls back gracefully to the parent model
- It supports fuzzy matching

### 8. Tool resolution

Map agent tool names to pi's built-in tool instances:

```typescript
import {
  readTool, bashTool, editTool, writeTool,
  grepTool, findTool, lsTool,
} from '@mariozechner/pi-coding-agent';

const TOOL_MAP: Record<string, Tool> = {
  read: readTool,
  bash: bashTool,
  edit: editTool,
  write: writeTool,
  grep: grepTool,
  find: findTool,
  ls: lsTool,
};

function resolveTools(toolNames: string[]): Tool[] {
  return toolNames
    .map(name => TOOL_MAP[name])
    .filter((t): t is Tool => t !== undefined);
}
```

After session creation, we also call `session.setActiveToolsByName()` to
ensure ONLY the declared tools are active — no inherited extension tools.

### 9. Result collection

After `session.prompt(task)` completes, extract everything from the session:

```typescript
function collectResult(
  session: AgentSession,
  agent: FlowAgentConfig,
  task: string,
  startedAt: number,
  turnState: { count: number; steered: boolean; aborted: boolean },
): SingleAgentResult {
  const stats = session.getSessionStats();

  // Extract final assistant text
  const responseText = session.getLastAssistantText() ?? '';

  // Extract tool calls from messages
  const toolCalls: ToolCallRecord[] = [];
  for (const msg of session.messages) {
    if (msg.role !== 'assistant') continue;
    for (const part of msg.content ?? []) {
      if (part.type === 'tool_use') {
        toolCalls.push({ name: part.name, args: part.input });
      }
    }
  }

  return {
    agent: agent.name,
    agentSource: agent.source,
    task,
    exitCode: turnState.aborted ? 1 : 0,
    responseText,
    toolCalls,
    usage: {
      input: stats.tokens.input,
      output: stats.tokens.output,
      cacheRead: stats.tokens.cacheRead,
      cacheWrite: stats.tokens.cacheWrite,
      cost: stats.cost,
      contextTokens: stats.tokens.total,
      turns: stats.toolCalls > 0 ? stats.userMessages : 0,
    },
    model: session.model ? `${session.model.provider}/${session.model.id}` : undefined,
    stopReason: turnState.aborted ? 'aborted' : turnState.steered ? 'steered' : undefined,
    startedAt,
    steered: turnState.steered,
    aborted: turnState.aborted,
  };
}
```

---

## What gets deleted

| File/Function | Reason |
|---|---|
| `spawn.ts` (entire file) | Replaced by `runner.ts` + `result-utils.ts` |
| `getPiInvocation()` | No CLI subprocess |
| `buildSpawnArgs()` | No CLI subprocess |
| `writeAgentPrompt()` | No temp files — prompt injected via `systemPromptOverride` |
| `processNdjsonLine()` | No NDJSON parsing — direct session access |
| `runChildProcess()` | No child process |
| `spawnAgent()` | Replaced by `runAgent()` |
| `spawnAgentWithRetry()` | No retry needed — no process spawn failures |
| `isTransientError()` | No transient errors possible |
| `RETRY_DELAYS_MS` | No retry logic |
| `getFinalOutput()` | Replaced by `session.getLastAssistantText()` |
| `getDisplayItems()` | Replaced by direct `toolCalls` on result |
| `DisplayItem` type | Replaced by `ToolCallRecord` |

## What gets added

| File/Function | Purpose |
|---|---|
| `runner.ts` | In-process agent execution via `createAgentSession()` |
| `result-utils.ts` | Pure utilities: `emptyResult`, `emptyUsage`, `aggregateUsage`, `mapWithConcurrencyLimit` |
| `resolveModel()` | Model resolution against registry with fuzzy matching |
| `resolveTools()` | Map tool names to pi built-in tool instances |
| `collectResult()` | Extract `SingleAgentResult` from completed session |
| Graceful turn limits | steer → grace → abort pattern |
| `RunAgentCallbacks` | Live streaming callbacks for rendering |

---

## Migration plan

### Phase 1: Extract utilities (no behavior change)

1. Create `result-utils.ts` with pure functions from `spawn.ts`:
   - `emptyUsage`, `emptyResult`, `aggregateUsage`, `mapWithConcurrencyLimit`
2. Update `dispatch.ts` and `rendering.ts` imports to use `result-utils.ts`
3. Run all tests — they must pass with zero changes

### Phase 2: Write `runner.ts` with tests (RED → GREEN)

1. Write `runner.test.ts` — mock `createAgentSession` and test:
   - Session creation with correct options
   - Model resolution (exact, fuzzy, fallback)
   - Tool resolution (all 7 tools)
   - Turn limit enforcement (steer at limit, abort at limit + grace)
   - Abort signal forwarding
   - Result collection (usage, text, tool calls)
   - Error handling (session.prompt throws)
2. Write `runner.ts` — make tests pass
3. Run runner tests — GREEN

### Phase 3: Update types (parallel change)

1. Add new fields to `SingleAgentResult` (`responseText`, `toolCalls`, `steered`, `aborted`)
2. Keep old fields (`messages`, `stderr`) temporarily for compatibility
3. Update rendering to handle both old and new shapes
4. Run all tests — must pass

### Phase 4: Wire dispatch to runner

1. Add `ctx: ExtensionContext` parameter to `executeDispatch`
2. Update `index.ts` to pass `ctx`
3. Replace `spawnAgentWithRetry` calls with `runAgent` calls
4. Update dispatch tests — mock `runAgent` instead of `spawnAgentWithRetry`
5. Run all tests — GREEN

### Phase 5: Clean up

1. Delete `spawn.ts`
2. Remove old fields from `SingleAgentResult` (`messages`, `stderr`)
3. Simplify rendering (remove `getDisplayItems`, `getFinalOutput`)
4. Update all test files
5. Run full test suite — GREEN

### Phase 6: New capabilities

1. Add steering support to `dispatch_flow` tool (new optional param)
2. Add graceful turn limits to agent frontmatter (`max_steps` already exists)
3. Add live budget tracking via `onUsageUpdate` callback
4. Update rendering to show steered/aborted status

---

## Test strategy

### `runner.test.ts` (new)

Mock `createAgentSession` from `@mariozechner/pi-coding-agent`. Test:

- **Session creation**: correct options (cwd, model, tools, resourceLoader, sessionManager)
- **Model resolution**: exact match, fuzzy match, fallback to parent
- **Tool resolution**: each tool name maps correctly, unknown tools filtered
- **System prompt**: `systemPromptOverride` returns injected prompt
- **Turn limits**: steer at `max_steps`, abort at `max_steps + grace`
- **Abort forwarding**: AbortSignal triggers `session.abort()`
- **Result collection**: usage stats, final text, tool calls, exit code
- **Error paths**: session.prompt throws → exitCode 1, errorMessage set
- **Callbacks**: onToolActivity, onTurnEnd, onUsageUpdate called correctly

### `dispatch.test.ts` (updated)

Replace `spawnAgentWithRetry` mocks with `runAgent` mocks. Same test cases,
different mock target.

### `rendering.test.ts` (updated)

Update test data to use new `SingleAgentResult` shape (`responseText` + `toolCalls`
instead of `messages`).

### `spawn.test.ts` → DELETE

All subprocess-specific tests become irrelevant.

---

## Risks and mitigations

### Risk: `createAgentSession` API changes

The SDK types are from `@mariozechner/pi-coding-agent@0.62.0`. The API surface
used (`createAgentSession`, `SessionManager.inMemory`, `session.prompt`,
`session.subscribe`, `session.steer`, `session.abort`, `session.getSessionStats`)
is stable — tintinweb depends on the same API at v0.5.2.

**Mitigation**: Pin `@mariozechner/pi-coding-agent` version. Type-check against
the installed version's `.d.ts` files.

### Risk: In-process sessions share memory

Unlike subprocess execution where each agent gets its own process, in-process
sessions share the Node.js heap. A misbehaving agent could theoretically affect
the parent session.

**Mitigation**: Sessions are isolated via `SessionManager.inMemory()` — no shared
mutable state. Extensions are disabled (`noExtensions: true`). Tools are sandboxed
to the declared set. The only shared resource is `modelRegistry`, which is read-only.

### Risk: Parallel execution memory pressure

Running 4-8 parallel agents in-process means 4-8 concurrent LLM conversations
in memory.

**Mitigation**: `mapWithConcurrencyLimit` already caps parallelism. Default
`max_workers` is 4. Sessions use `SessionManager.inMemory()` which is lightweight.
The real memory cost is in LLM context — same as with subprocesses (pi loads
context into memory regardless of execution model).

### Risk: Agent can call extension tools

In subprocess mode, `--no-extensions` prevented agents from accessing the parent's
extension tools (including `dispatch_flow` itself).

**Mitigation**: Two layers of defense:
1. `noExtensions: true` on `DefaultResourceLoader` — no extensions loaded
2. `session.setActiveToolsByName(agent.tools)` — explicit allowlist, only
   declared tools are active. Even if an extension tool somehow loaded, it
   wouldn't be in the active set.
