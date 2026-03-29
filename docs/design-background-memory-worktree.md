# Design: Background Execution, Memory Persistence & Worktree Isolation

## Status

**Implemented** — all three features complete on `feature/memory` branch.

## Motivation

pi-flow now runs agents in-process via `createAgentSession()` (matching tintinweb's architecture). Three capabilities that both tintinweb and nico offer remain missing:

1. **Background execution** — fire-and-forget agents that run while the coordinator continues
2. **Memory persistence** — agents accumulate knowledge across dispatches and sessions
3. **Worktree isolation** — writable agents get a clean git sandbox, preventing contamination

These features are not just parity items — they unlock new workflow patterns:
- Scout investigating in background while builder codes
- Reviewer remembering past review patterns and recurring issues
- Builder working in isolation without polluting the coordinator's working tree

## Design Principles

1. **Full feature adoption, not watered-down** — match tintinweb's depth, then enhance for pi-flow's workflow model
2. **Workflow-aware** — every feature integrates with pi-flow's feature state machine, variable injection, and agent roles
3. **Clean architecture preserved** — one file per concern, pure functions where possible, co-located tests

---

## Feature 1: Background Execution

### What tintinweb does

tintinweb has a full background execution system:
- `AgentManager` class (409 lines) — tracks agents, queues excess, drains on completion
- `GroupJoinManager` (141 lines) — batches completion notifications for parallel background agents
- `get_subagent_result` tool — coordinator polls/blocks on background agent results
- `steer_subagent` tool — coordinator sends mid-run messages to running background agents
- `pi.sendMessage({ deliverAs: "followUp", triggerTurn: true })` — notifies coordinator on completion
- Configurable max concurrency (default 4), queue with auto-drain
- Agent statuses: queued → running → completed/steered/aborted/stopped/error
- Output files for streaming transcripts
- `AgentWidget` for live UI status

### What pi-flow should adopt

**Full `AgentManager` pattern** — not a lightweight tracker. The manager owns the lifecycle:

```
spawn() → [queued] → [running] → [completed | aborted | error]
                                      ↓
                              notify coordinator
```

#### New file: `src/background.ts` (~300 lines)

```typescript
export class BackgroundManager {
  private agents: Map<string, BackgroundRecord>;
  private runningCount: number;
  private maxConcurrent: number;
  private queue: QueuedAgent[];

  // Lifecycle
  spawn(options: SpawnOptions): string;         // returns agent ID immediately
  spawnAndWait(options: SpawnOptions): Promise<BackgroundRecord>; // foreground path
  
  // Status
  getRecord(id: string): BackgroundRecord | undefined;
  listAgents(): BackgroundRecord[];
  hasRunning(): boolean;
  waitForAll(): Promise<void>;

  // Control
  abort(id: string): void;
  abortAll(): void;
  steer(id: string, message: string): Promise<void>;

  // Queue management
  private drainQueue(): void;
  private startAgent(id: string, record: BackgroundRecord, args: SpawnArgs): void;

  // Cleanup
  clearCompleted(): void;
  dispose(): void;
}
```

#### BackgroundRecord — richer than tintinweb's

```typescript
export interface BackgroundRecord {
  id: string;
  agent: FlowAgentConfig;      // pi-flow: we know the agent config
  task: string;
  feature?: string;             // pi-flow: feature binding
  description: string;
  status: "queued" | "running" | "completed" | "steered" | "aborted" | "error";
  result?: string;
  error?: string;
  toolUses: number;
  turnCount: number;
  startedAt: number;
  completedAt?: number;
  session?: AgentSession;
  abortController: AbortController;
  promise?: Promise<SingleAgentResult>;
  pendingSteers?: string[];     // queued before session ready
  worktree?: WorktreeInfo;      // if isolation enabled
  worktreeResult?: WorktreeCleanupResult;
  usage?: UsageStats;           // pi-flow: budget tracking
}
```

#### New tools: `get_agent_result` and `steer_agent`

Registered alongside `dispatch_flow` in `index.ts`:

**`get_agent_result`** — same shape as tintinweb's:
```typescript
parameters: {
  agent_id: string;     // agent ID from background dispatch
  wait?: boolean;       // block until complete (default: false)
  verbose?: boolean;    // include full conversation
}
```

**`steer_agent`** — mid-run redirection:
```typescript
parameters: {
  agent_id: string;
  message: string;      // injected as user message into running agent
}
```

#### Notification on completion — `pi.sendMessage`

When a background agent completes, notify the coordinator:
```typescript
pi.sendMessage({
  customType: "flow-agent-complete",
  content: formatCompletionNotification(record),
  display: true,
  details: buildNotificationDetails(record),
}, { deliverAs: "followUp", triggerTurn: true });
```

This is the key API — `triggerTurn: true` causes the coordinator to process the result. Without this, background agents complete silently.

#### Group join — adopt tintinweb's `GroupJoinManager`

When multiple scouts are dispatched in parallel via `dispatch_flow({ parallel: [...] })`, group their completion notifications:

```typescript
export class GroupJoinManager {
  registerGroup(groupId: string, agentIds: string[]): void;
  onAgentComplete(record: BackgroundRecord): 'delivered' | 'held' | 'pass';
  dispose(): void;
}
```

Default timeout: 30s after first completion. Straggler re-batch: 15s. Partial delivery if some agents still running.

#### Integration with `dispatch_flow`

Add `background?: boolean` parameter:

```typescript
parameters: {
  // existing...
  background: Type.Optional(Type.Boolean({
    description: "Run agents in background. Returns agent IDs immediately. " +
      "You'll be notified on completion. Use get_agent_result to retrieve results.",
  })),
}
```

When `background: true`:
- Single mode: `manager.spawn()` → return ID immediately
- Parallel mode: spawn all → register group → return IDs immediately
- Chain mode: **not supported in background** (chains are inherently sequential with `{previous}` substitution)

#### Dispatch mode matrix

| Mode | Foreground (default) | Background |
|---|---|---|
| Single | `spawnAndWait()` → return result | `spawn()` → return ID |
| Parallel | `mapWithConcurrencyLimit` → return results | spawn all + group join → return IDs |
| Chain | sequential with `{previous}` | ❌ not supported (error) |

### Enhancement over tintinweb

1. **Feature-scoped background agents** — budget tracking accumulates for background agents bound to a feature
2. **Artifact collection on background completion** — when a background scout finishes, its findings are written to the feature dir
3. **Session dispatch log** — background completions logged to session state
4. **Chain rejection** — explicit error when trying to background a chain (tintinweb doesn't have chains)

---

## Feature 2: Memory Persistence

### What tintinweb does

tintinweb's memory system (165 lines):
- Three scopes: `user` (~/.pi/agent-memory/{name}/), `project` (.pi/agent-memory/{name}/), `local` (.pi/agent-memory-local/{name}/)
- `MEMORY.md` as an index file (200-line limit)
- Arbitrary files in the memory directory
- Write-capable agents get write/edit tools added if missing
- Read-only agents get a read-only memory block
- Symlink attack prevention
- Memory block injected via system prompt `extras`

### What pi-flow already has

Pi-flow has a simpler memory system:
- `.flow/memory/decisions.md` → `{{MEMORY_DECISIONS}}`
- `.flow/memory/patterns.md` → `{{MEMORY_PATTERNS}}`
- `.flow/memory/lessons.md` → `{{MEMORY_LESSONS}}`
- Read-only: injected via `buildVariableMap()` → `injectVariables()`
- No write capability — agents can't update memory
- No per-agent isolation — all agents share the same memory files

### What pi-flow should adopt

**Full tintinweb-style per-agent memory with two scopes** plus pi-flow's existing cross-agent memory.

#### Memory architecture

```
.flow/
├── memory/                           # Cross-agent memory (existing)
│   ├── decisions.md                  # Architectural decisions
│   ├── patterns.md                   # Codebase patterns
│   └── lessons.md                    # Lessons learned
│
└── agent-memory/                     # Per-agent memory (NEW)
    ├── scout/
    │   └── MEMORY.md                 # Scout's persistent notes
    ├── builder/
    │   └── MEMORY.md                 # Builder's persistent notes
    ├── reviewer/
    │   └── MEMORY.md                 # Reviewer's persistent notes
    └── ...

~/.pi/flow-memory/                    # Global per-agent memory (NEW)
    ├── scout/
    │   └── MEMORY.md
    └── ...
```

Three layers:
1. **Cross-agent memory** (existing `.flow/memory/`) — shared knowledge injected via `{{MEMORY_*}}` variables. Any writable agent can update these.
2. **Project per-agent memory** (new `.flow/agent-memory/{name}/`) — agent-specific knowledge for this project. Scout remembers project structure; builder remembers build patterns.
3. **Global per-agent memory** (new `~/.pi/flow-memory/{name}/`) — cross-project knowledge. Reviewer remembers common review patterns across all projects.

#### New file: `src/memory.ts` (~200 lines)

Adopt tintinweb's full module with enhancements:

```typescript
export type MemoryScope = "project" | "global";

// Security
export function isUnsafeName(name: string): boolean;
export function isSymlink(filePath: string): boolean;
export function safeReadFile(filePath: string): string | undefined;

// Resolution
export function resolveMemoryDir(agentName: string, scope: MemoryScope, cwd: string): string;
export function ensureMemoryDir(memoryDir: string): void;
export function readMemoryIndex(memoryDir: string): string | undefined;

// Prompt building
export function buildMemoryBlock(agentName: string, scope: MemoryScope, cwd: string): string;
export function buildReadOnlyMemoryBlock(agentName: string, scope: MemoryScope, cwd: string): string;

// pi-flow enhancement: cross-agent memory update instructions
export function buildCrossAgentMemoryBlock(memoryDir: string, writable: boolean): string;
```

#### Agent config extension

Add `memory` field to `FlowAgentConfig`:

```yaml
# agents/reviewer.md
---
name: reviewer
memory: project    # "project" | "global" — scope for persistent memory
# ...
---
```

#### Memory scope by agent role

| Agent | Memory Scope | Can Write | Rationale |
|---|---|---|---|
| scout | project | read-only | Scouts don't write files |
| probe | project | read-only | Probes don't write files |
| planner | project | ✅ write | Records architectural decisions |
| builder | project | ✅ write | Records implementation patterns |
| test-writer | project | ✅ write | Records testing patterns |
| reviewer | global | ✅ write | Review patterns apply cross-project |
| doc-writer | project | ✅ write | Records documentation conventions |

#### Integration with runner.ts

In `runAgent()`, before session creation:
1. Check if agent has `memory` config
2. If writable agent: `buildMemoryBlock()` → full instructions + existing MEMORY.md
3. If read-only agent: `buildReadOnlyMemoryBlock()` → existing MEMORY.md (no write instructions)
4. Inject memory block into system prompt alongside existing variable injection
5. If writable agent lacks write/edit tools but has memory, add them (like tintinweb does)

#### Integration with variable map

The existing `{{MEMORY_PATTERNS}}` etc. variables continue to work. The new per-agent memory is **additive** — injected as a separate block in the system prompt.

```
System prompt structure:
1. Agent instructions (from .md)
2. {{MEMORY_PATTERNS}} etc. (cross-agent, existing)
3. [Agent Memory Block] (per-agent, new)
   - Location of MEMORY.md
   - Existing memory contents
   - Write instructions (if writable)
```

### Enhancement over tintinweb

1. **Two-tier memory** — per-agent + cross-agent (tintinweb only has per-agent)
2. **Cross-agent memory is writable** — builder can update patterns.md that scout reads next time
3. **Role-aware defaults** — memory scope automatically set by agent role, not manual config
4. **Feature-aware memory** — per-agent memory lives under `.flow/` alongside feature state

---

## Feature 3: Worktree Isolation

### What tintinweb does

tintinweb's worktree system (162 lines):
- `createWorktree(cwd, agentId)` — creates a detached worktree at HEAD in `/tmp/`
- `cleanupWorktree(cwd, worktree, description)` — on completion:
  - No changes → remove worktree
  - Changes exist → stage, commit, create branch, remove worktree
- `pruneWorktrees(cwd)` — crash recovery, removes orphaned worktrees
- Branch naming: `pi-agent-{agentId}` (with timestamp suffix on collision)
- Integration: worktree path passed as `cwd` override to `runAgent()`

### What pi-flow should adopt

**Tintinweb's full worktree module** with workflow-aware enhancements:

#### New file: `src/worktree.ts` (~180 lines)

```typescript
export interface WorktreeInfo {
  path: string;       // absolute path to worktree directory
  branch: string;     // branch name for this worktree
}

export interface WorktreeCleanupResult {
  hasChanges: boolean;
  branch?: string;    // branch name if changes were committed
  path?: string;      // worktree path if kept
}

export function createWorktree(cwd: string, agentId: string, feature?: string): WorktreeInfo | undefined;
export function cleanupWorktree(cwd: string, worktree: WorktreeInfo, description: string): WorktreeCleanupResult;
export function pruneWorktrees(cwd: string): void;
```

#### Feature-scoped branch naming

tintinweb: `pi-agent-{agentId}`
pi-flow: `flow/{feature}/{agent}-{timestamp}`

Examples:
- `flow/auth-refactor/builder-1719849600`
- `flow/auth-refactor/test-writer-1719849600`
- `flow/ad-hoc/builder-1719849600` (no feature bound)

This makes branches discoverable by feature and agent role.

#### Agent config extension

Add `isolation` field to `FlowAgentConfig`:

```yaml
# agents/builder.md
---
name: builder
isolation: worktree   # "worktree" | undefined
writable: true
# ...
---
```

Default: writable agents (`writable: true`) automatically get `isolation: worktree` unless explicitly disabled.

| Agent | Isolation | Rationale |
|---|---|---|
| scout | none | Read-only, no file changes |
| probe | none | Read-only, no file changes |
| planner | none | Writes to `.flow/` only, not source files |
| builder | **worktree** | Writes source files — needs isolation |
| test-writer | **worktree** | Writes test files — needs isolation |
| reviewer | none | Read-only analysis |
| doc-writer | **worktree** | Writes documentation files |

#### Integration with runner.ts

```typescript
// In runAgent():
let effectiveCwd = ctx.cwd;
let worktreeInfo: WorktreeInfo | undefined;

if (agent.isolation === 'worktree') {
  worktreeInfo = createWorktree(ctx.cwd, `${agent.name}-${Date.now()}`, feature);
  if (worktreeInfo) {
    effectiveCwd = worktreeInfo.path;
  }
}

// Create session with effectiveCwd
const { session } = await createAgentSession({ cwd: effectiveCwd, ... });

// On completion:
if (worktreeInfo) {
  const result = cleanupWorktree(ctx.cwd, worktreeInfo, task);
  if (result.hasChanges && result.branch) {
    // Append branch info to agent result
    agentResult.worktreeBranch = result.branch;
  }
}
```

#### Worktree result in SingleAgentResult

```typescript
export interface SingleAgentResult {
  // ... existing fields
  worktreeBranch?: string;  // NEW: branch name if worktree had changes
}
```

The rendering layer shows:
```
┌ Builder (completed in 45s)
│ Changes saved to branch flow/auth-refactor/builder-1719849600
│ Merge with: git merge flow/auth-refactor/builder-1719849600
└ 12 tool uses · 45.2k tokens
```

#### Startup cleanup

In `index.ts` `session_start`:
```typescript
pruneWorktrees(ctx.cwd);
```

### Enhancement over tintinweb

1. **Feature-scoped branches** — branches organized by feature, not random agent IDs
2. **Auto-isolation for writable agents** — no need for the coordinator to specify `isolation: "worktree"` every time
3. **Worktree result in dispatch response** — coordinator sees branch name in the tool result, can instruct merge
4. **Startup pruning** — automatic crash recovery

---

## Implementation Phases

### Phase A: Memory Persistence (~200 lines src + ~200 lines test)

**Files:**
1. `src/memory.ts` — memory module (resolve, read, build blocks, security)
2. `src/memory.test.ts` — full coverage
3. Update `src/runner.ts` — inject memory block into session
4. Update `src/agents.ts` — parse `memory` from frontmatter
5. Update agent `.md` files — add `memory:` field and `{{MEMORY_BLOCK}}`

**Tests:** isUnsafeName, isSymlink, safeReadFile, resolveMemoryDir (both scopes), ensureMemoryDir, readMemoryIndex (missing, exists, truncation, symlink rejection), buildMemoryBlock (writable, read-only), buildCrossAgentMemoryBlock

### Phase B: Worktree Isolation (~180 lines src + ~150 lines test)

**Files:**
1. `src/worktree.ts` — worktree module (create, cleanup, prune)
2. `src/worktree.test.ts` — full coverage
3. Update `src/runner.ts` — worktree create/cleanup around session
4. Update `src/agents.ts` — parse `isolation` from frontmatter
5. Update `src/types.ts` — add `worktreeBranch` to `SingleAgentResult`
6. Update `src/rendering.ts` — show branch info in agent cards
7. Update agent `.md` files — add `isolation: worktree` for writable agents

**Tests:** createWorktree (git repo, no repo, no commits), cleanupWorktree (no changes, with changes, branch collision, error), pruneWorktrees, feature-scoped branch naming

### Phase C: Background Execution (~300 lines src + ~250 lines test)

**Files:**
1. `src/background.ts` — BackgroundManager + GroupJoinManager
2. `src/background.test.ts` — full coverage
3. Update `src/dispatch.ts` — background path in executeSingle/executeParallel
4. Update `src/index.ts` — register `get_agent_result` and `steer_agent` tools, wire manager lifecycle
5. Update `src/types.ts` — BackgroundRecord, DispatchParams.background
6. Update `src/rendering.ts` — background agent status in cards

**Tests:** BackgroundManager (spawn, queue, drain, abort, steer, concurrent limits, dispose), GroupJoinManager (register, complete, timeout, partial delivery, straggler), tool integration (get_agent_result polling/blocking, steer_agent routing)

### Phase D: Integration & Polish (~50 lines)

1. Wire `session_start` → `pruneWorktrees()` + `manager.clearCompleted()`
2. Wire `session_shutdown` → `manager.abortAll()` + `manager.dispose()`
3. Budget tracking for background agents on feature completion
4. Artifact/finding collection on background completion
5. Update design doc status

## Estimated Totals

| Phase | Source Lines | Test Lines | New Files |
|---|---|---|---|
| A: Memory | ~200 | ~200 | 2 (memory.ts, memory.test.ts) |
| B: Worktree | ~180 | ~150 | 2 (worktree.ts, worktree.test.ts) |
| C: Background | ~300 | ~250 | 2 (background.ts, background.test.ts) |
| D: Integration | ~50 | ~0 | 0 |
| **Total** | **~730** | **~600** | **6** |

Post-implementation pi-flow will have:
- ~4,430 source lines (3,700 + 730)
- ~4,373 test lines (3,773 + 600)
- ~20 source files (14 + 6)
- Still compact: tintinweb has 4,836 lines in 20 files for a general-purpose system; pi-flow will have ~4,430 lines in 20 files for a workflow-specialized system with the same capabilities plus TDD enforcement, feature state, and spec-driven prompts.
