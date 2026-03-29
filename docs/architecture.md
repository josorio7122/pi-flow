# Architecture

## System Overview

pi-flow is a pi extension with two layers:

1. **Agent system** — Spawn, manage, and communicate with autonomous sub-agents
2. **Workflow engine** — Orchestrate multiple agents through multi-phase pipelines

The agent system works standalone (LLM calls `Agent` tool directly). The workflow engine builds on top, using the agent system's `spawnAndWait` as its execution primitive.

## Data Flow

### Agent Spawn (foreground)

```
LLM calls Agent tool
  → registerAgentTool.execute()
    → manager.spawnAndWait()
      → buildAgentSession()     # resolve tools, model, prompt, memory, skills
        → createAgentSession()  # pi API: create session with resolved config
          → session.prompt()    # execute agent
      → return result to LLM
```

### Agent Spawn (background)

```
LLM calls Agent tool (run_in_background: true)
  → registerAgentTool.execute()
    → manager.spawn()          # returns ID immediately
      → runAgent() (async)     # runs in background
        → on complete:
          → lifecycle.onComplete()
            → groupJoin.onAgentComplete()  # or individual nudge
              → notification via pi.sendMessage()
```

### Workflow Execution

```
LLM calls Workflow tool (action: "start")
  → integration.startWorkflow()
    → createWorkflowState()    # initialize state.json
    → executeCurrentPhase()    # begin phase loop
      → dispatchPhase()        # route by mode
        → executeSinglePhase() / executeParallelPhase() / executeReviewLoop() / executeGatePhase()
          → buildPhasePrompt() # inject workflow context + handoff
          → manager.spawnAndWait() # delegate to agent system
          → writeHandoff()     # persist agent output
      → advanceToNextPhase()   # recurse to next phase
```

## Module Map

### `src/index.ts` — Extension Entry Point

Wires everything together:
- Creates the agent manager, registry, widget, notifications, batch system
- Registers tools (Agent, get_subagent_result, steer_subagent)
- Registers commands (/agents)
- Registers RPC handlers for cross-extension communication
- Registers the workflow extension
- Sets up session lifecycle hooks

Uses **late-bound getters** (`getWidget()`, `getBatch()`, `getNotifications()`) to break circular initialization dependencies between manager callbacks and UI components.

### `src/agents/` — Agent System

**`manager.ts`** — Central agent lifecycle manager.
- Tracks all agents in a `Map<id, AgentRecord>`
- Enforces concurrency limit (default 4) with a FIFO queue
- `spawn()` → returns ID immediately (background)
- `spawnAndWait()` → awaits completion (foreground)
- `resume()` → re-prompts an existing session
- Handles worktree creation/cleanup on completion
- Auto-cleans stale records after 10 minutes

**`runner.ts`** — Session execution.
- `runAgent()` — Creates session, manages turn limits (soft steer → hard abort), forwards abort signal
- `resumeAgent()` — Prompts an existing session
- Collects response text via session event subscription

**`session.ts`** — Agent session builder.
- Resolves: tools (from registry), model (from config or parent), memory (directory + MEMORY.md), skills (preloaded), system prompt (append/replace mode), extensions (filtered)
- Creates an `AgentSession` via pi's `createAgentSession` API
- Filters tools by `disallowedTools` and `extensions` config

**`registry.ts`** — Unified agent type registry.
- Merges defaults + user agents
- Case-insensitive name resolution
- Provides tools, config, and metadata by type name
- `BUILTIN_TOOL_NAMES` derived from tool factory registry

**`custom.ts`** — Loads `.md` agent files from project/global/builtin directories.
- Parses YAML frontmatter → `AgentConfig`
- Field parsers: `csvList`, `inheritField`, `parseThinking`, etc.

**`defaults.ts`** — Embedded default agents (`general-purpose`, `Explore`, `Plan`).

**`manager-types.ts`** — Manager interfaces: `SpawnArgs`, `SpawnOptions`, `OnAgentComplete`, `DEFAULT_MAX_CONCURRENT`.

**`runner-types.ts`** — Runner interfaces: `RunOptions`, `RunnerSettings`, `ToolActivity`. Also `createRunnerSettings()` and `normalizeMaxTurns()`.

**`batch.ts`** — Smart join: groups agents spawned in the same turn (100ms debounce).

**`lifecycle.ts`** — Completion routing: emits events, writes records, routes to group join or individual notification.

**`notification.ts`** — Debounced delivery of completion notifications with custom message rendering.

**`tools/agent-tool.ts`** — The `Agent` tool: handles model resolution, background/foreground/resume paths, live progress updates via `onUpdate`.

**`tools/agent-render.ts`** — Pure render functions for `Agent` tool call/result display: spinner, stats, status icons.

**`tools/result-tool.ts`** — `get_subagent_result`: check status, wait for completion, retrieve full output including conversation.

**`tools/steer-tool.ts`** — `steer_subagent`: send mid-run messages to running agents.

### `src/config/` — Configuration Resolution

**`invocation.ts`** — Merges agent config defaults with per-invocation tool parameters. Agent config wins over params for thinking, model, etc.

**`model-resolver.ts`** — Resolves model strings. Exact match (`provider/modelId`) first, then fuzzy scoring against available models.

**`prompts.ts`** — Builds the system prompt. `replace` mode: env header + custom prompt. `append` mode: env header + parent prompt + bridge + custom instructions.

**`skill-loader.ts`** — Reads named skill `.md` files from `.pi/skills/` directories and injects content into the prompt.

### `src/extension/` — pi Extension Integration

**`command/`** — The `/agents` interactive menu:
- `command.ts` — Entry point and top-level menu
- `types.ts` — Shared types, helpers, model label formatting
- `views.ts` — Read-only views: agent list, running agents, agent detail, conversation viewer
- `mutations.ts` — Mutating operations: eject to `.md`, disable, enable
- `wizards.ts` — Agent creation: generate with Claude or manual configuration
- `settings.ts` — Settings submenu: concurrency, max turns, grace turns, join mode

**`group-join.ts`** — Groups background agent completions. Pure core (processCompletion, processTimeout) + impure shell (setTimeout scheduling).

**`helpers.ts`** — Shared formatting: `textResult()`, `buildDetails()`, `buildNotificationDetails()`, `formatTaskNotification()`.

**`activity-tracker.ts`** — Tracks tool usage, turns, tokens for live progress updates.

**`rpc.ts`** — Cross-extension RPC over `pi.events`: `ping`, `spawn`, `stop` with per-request reply channels.

### `src/infra/` — Infrastructure

**`context.ts`** — Extracts parent conversation history for `inherit_context`.

**`env.ts`** — Detects git repo, branch, platform for system prompts.

**`memory.ts`** — Persistent agent memory: directory management, MEMORY.md reading, prompt generation.

**`output-file.ts`** — JSONL transcript streaming for background agents.

**`worktree.ts`** — Git worktree creation, cleanup (commit changes to branch), pruning.

### `src/ui/` — TUI Rendering

**`formatters.ts`** — Pure format helpers (tokens, duration, turns, activity) + shared types (`AgentActivity`, `AgentDetails`).

**`widget.ts`** — Persistent widget above the editor: shows running/completed/queued agents with live updates.

**`widget-render.ts`** — Pure render functions for widget lines (finished, running, overflow).

**`viewer.ts`** — Scrollable conversation overlay (Component class required by pi's TUI API).

**`viewer-content.ts`** — Pure content builder: renders agent messages into display lines.

### `src/workflow/` — Workflow Engine

**`types.ts`** — All workflow type definitions: `WorkflowDefinition`, `WorkflowState`, `AgentHandoff`, `WorkflowEvent`, `Task`, etc.

**`loader.ts`** — Discovers and parses workflow `.md` files. Same pattern as `custom.ts` for agents.

**`pipeline.ts`** — Pure phase state machine: `createWorkflowState()`, `updatePhaseStatus()`, `checkTokenLimit()`, `detectStuckIssues()`.

**`executor.ts`** — Core orchestration: `executeCurrentPhase()` → token check → dispatch → advance to next. Recursive — completes the entire workflow in one call.

**`executor-helpers.ts`** — `resolveContextHandoff()` (find handoff from `contextFrom` phase), `accumulateTokens()`, `buildInterruptedContext()` (crash recovery), `trackAgentStart/Complete()`.

**`phase-dispatch.ts`** — Routes `phase.mode` to the correct handler.

**`phase-single.ts`** — Spawn one agent, write handoff.

**`phase-parallel.ts`** — Extract tasks from previous handoff, spawn agents concurrently via `Promise.all`, block/complete tasks.

**`phase-review.ts`** — Review-fix loop: spawn reviewer → parse verdict → if NEEDS_WORK, spawn fixer → repeat.

**`phase-gate.ts`** — Emit event, return `gate-waiting`. Workflow pauses until user approves.

**`prompt-builder.ts`** — Pure functions: `buildPhasePrompt()`, `buildReviewPrompt()`, `buildFixPrompt()`. Assembles workflow context + handoff into agent prompts.

**`store.ts`** — All filesystem I/O for workflows. Atomic writes (temp + rename). `readJson` with type guards. State, handoffs (numbered files), events (JSONL).

**`task-store.ts`** — Task CRUD for parallel phases. Each task is a JSON file with status, dependencies, attempt count.

**`verdict.ts`** — Regex parser: extracts SHIP/NEEDS_WORK/MAJOR_RETHINK + issues + suggestions from reviewer markdown.

**`recovery.ts`** — `findStalled()` detects agents running > timeout. `buildContinuationPrompt()` builds context-aware restart instructions.

**`progress.ts`** — Widget lines and status bar text for the active workflow.

**`helpers.ts`** — Shared workflow helpers: `refreshWidget()`, `findLatestBookmark()`, `textResult()`.

**`flow-command.ts`** — `/flow` command: shows progress, allows abort.

**`integration.ts`** — Wires workflow engine into pi: registers Workflow tool, /flow command, session_start hook (recovery), turn_end hook (widget refresh).

## Design Principles

1. **Generic engine** — Agents and workflows are defined via `.md` files, not TypeScript. The engine is 100% data-driven.

2. **Hub-and-spoke** — Agents don't communicate directly. The orchestrator reads handoff files and builds prompts for the next agent.

3. **Pure core, impure shell** — State machines (`pipeline.ts`), formatters, prompt builders are all pure functions. Side effects (I/O, timers, pi API calls) are pushed to the edges.

4. **Atomic persistence** — All writes use temp file + rename. JSONL for events (append-only, crash-safe). JSON for mutable state (atomic overwrite).

5. **Crash-safe** — Recovery bookmarks via `appendEntry`. State files survive interruption. Continuation prompts prevent duplicate work.

6. **Token budgets** — Every workflow has a token limit. The engine tracks tokens per-phase and halts when the budget is exhausted.
