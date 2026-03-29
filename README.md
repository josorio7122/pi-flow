# pi-flow

A [pi](https://github.com/mariozechner/pi) extension that adds autonomous sub-agents and structured workflow orchestration.

Agents handle complex tasks in the background while you keep working. Workflows chain multiple specialized agents through defined phases — scout → plan → build → review — with handoff context, crash recovery, and token budgets.

## Install

### From git (recommended)

```bash
pi install git:github.com/josorio7122/pi-flow
```

Or add to your `~/.pi/agent/settings.json` (global) or `.pi/settings.json` (project):

```json
{
  "packages": ["git:github.com/josorio7122/pi-flow"]
}
```

### Quick test (temporary, current session only)

```bash
pi -e git:github.com/josorio7122/pi-flow
```

### Local development

```bash
git clone git@github.com:josorio7122/pi-flow.git
cd pi-flow
npm install
pi -e ./src/index.ts
```

## Quick Start

### Agents

The LLM can spawn agents via the `Agent` tool. You can also trigger them directly:

```
> Explore the authentication module and explain how tokens are refreshed.
```

The LLM will spawn an **Explore** agent (read-only, haiku-fast) to scan the codebase, then report back.

```
> Use the builder agent to add input validation to the /users endpoint.
```

Background agents run concurrently (up to 4 by default). Use `/agents` to manage them.

### Workflows

Workflows orchestrate multiple agents through defined phases:

```
> Start the feature workflow: Add rate limiting to the API
```

This triggers: **plan** → **approve-plan** (gate) → **test** → **build** → **review** (loop).

Use `/flow` to check progress or abort.

## Agents

### Built-in Agents

| Name | Model | Tools | Description |
|------|-------|-------|-------------|
| `general-purpose` | inherit | all | Default fallback for any task |
| `Explore` | haiku | read-only | Fast codebase exploration |
| `Plan` | inherit | read-only | Implementation planning |

### Bundled Specialist Agents

Defined in `agents/*.md` — override by placing a file with the same name in `.pi/agents/`.

| Name | Model | Tools | Description |
|------|-------|-------|-------------|
| `scout` | haiku | read-only | Traces code paths, maps structure, finds root causes |
| `builder` | sonnet | all | Writes code, runs tests, fixes issues with minimal diff |
| `reviewer` | sonnet | read-only | Two-pass review with structured verdict |
| `planner` | opus | read-only | Architecture analysis and implementation strategy |
| `test-writer` | sonnet | all | Traces codepaths, writes failing tests first |

### Custom Agents

Create `.md` files with YAML frontmatter:

**Project-level:** `.pi/agents/<name>.md` (highest priority)
**Global:** `~/.pi/agent/agents/<name>.md`

```markdown
---
description: Security auditor — finds vulnerabilities and suggests fixes
tools: read, bash, grep, find, ls
model: anthropic/claude-sonnet-4-6
thinking: medium
max_turns: 30
prompt_mode: append
---

# Role

You are a security auditor. Analyze code for vulnerabilities including:
- SQL injection, XSS, CSRF
- Authentication and authorization flaws
- Secrets in source code
- Dependency vulnerabilities

Report findings with severity, file, line, and suggested fix.
```

### Agent Configuration Reference

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `description` | string | name | One-line description shown in UI |
| `tools` | CSV | all | Built-in tools: `read, bash, edit, write, grep, find, ls` |
| `disallowed_tools` | CSV | none | Tools to block even if extensions provide them |
| `model` | string | inherit | Model as `provider/modelId` |
| `thinking` | string | inherit | `off`, `minimal`, `low`, `medium`, `high`, `xhigh` |
| `max_turns` | number | unlimited | Max agentic turns before wrap-up |
| `prompt_mode` | string | `replace` | `append` inherits parent prompt; `replace` uses only this prompt |
| `extensions` | bool/CSV | `true` | `true` = all, `false` = none, CSV = listed only |
| `skills` | bool/CSV | `true` | Same as extensions |
| `inherit_context` | bool | `false` | Fork parent conversation into agent |
| `run_in_background` | bool | `false` | Default to background execution |
| `isolated` | bool | `false` | No extension/MCP tools |
| `memory` | string | none | `user`, `project`, or `local` — persistent memory directory |
| `isolation` | string | none | `worktree` for git worktree isolation |
| `enabled` | bool | `true` | `false` hides from registry |

### Prompt Modes

**`replace`** — The agent gets only the environment header + your system prompt. Full control, no parent context.

**`append`** — The agent inherits the parent's full system prompt (including AGENTS.md, skills, sub_agent_context bridge) and appends your instructions in an `<agent_instructions>` block. Best for specialists that need project context.

### Tools Available to Agents

| Tool | Description |
|------|-------------|
| `Agent` | Spawn a sub-agent (LLM-callable) |
| `get_subagent_result` | Check status / retrieve background agent results |
| `steer_subagent` | Send a mid-run message to a running agent |

### Agent Features

- **Concurrency control** — Up to 4 background agents (configurable via `/agents > Settings`)
- **Smart join** — Agents spawned in the same turn are grouped; one consolidated notification
- **Steering** — Send messages to running agents via `steer_subagent`
- **Resume** — Re-prompt a completed agent's session
- **Turn limits** — Soft limit steers the agent to wrap up; hard limit aborts after grace turns
- **Worktree isolation** — `isolation: worktree` runs agent in a temporary git worktree; changes saved to a branch on completion
- **Persistent memory** — Agents with `memory` get a persistent directory for cross-session knowledge
- **Output transcripts** — Background agents stream JSONL transcripts to `/tmp/pi-flow-*/`
- **Live widget** — Running agents shown above the editor with real-time status

## Workflows

Workflows define multi-phase pipelines using the same `.md` format as agents.

### Built-in Workflows

| Name | Phases | Description |
|------|--------|-------------|
| `research` | scout | Scout the codebase and report findings |
| `explore` | scout → plan | Scout, then plan based on findings |
| `fix` | scout → approve → build → review | Scout a bug, approve fix plan, implement, review |
| `feature` | plan → approve → test → build → review | Full TDD workflow with planning and review |

### Custom Workflows

**Project-level:** `.pi/workflows/<name>.md` (highest priority)
**Global:** `~/.pi/agent/workflows/<name>.md`
**Built-in:** `workflows/<name>.md` in the extension directory

```markdown
---
name: deploy
description: Build, test, and deploy with approval gate
triggers:
  - deploy to production
  - ship it

phases:
  - name: build
    role: builder
    mode: single
    description: Run the full build and test suite

  - name: approve
    mode: gate
    description: Review build results before deploying

  - name: deploy
    role: builder
    mode: single
    description: Run deployment scripts
    contextFrom: build

config:
  tokenLimit: 150000
  maxTurnsPerAgent: 30
---

Build and deploy instructions for the orchestrator.
This text is injected into every agent prompt as context.
```

### Workflow Configuration Reference

**Frontmatter fields:**

| Field | Type | Description |
|-------|------|-------------|
| `name` | string | Workflow identifier (defaults to filename) |
| `description` | string | Shown in the Workflow tool description |
| `triggers` | string[] | Hint phrases for when to use this workflow |
| `phases` | PhaseDefinition[] | Ordered list of phases (see below) |
| `config.tokenLimit` | number | Total token budget (default: 100,000) |
| `config.maxTurnsPerAgent` | number | Per-agent turn limit |

**Body text** becomes `orchestratorInstructions` — injected into every agent prompt.

### Phase Modes

| Mode | Description |
|------|-------------|
| `single` | Spawn one agent, wait for result, write handoff |
| `parallel` | Parse tasks from previous handoff, spawn agents for each task concurrently |
| `gate` | Pause execution until the user approves via `Workflow({ action: "continue" })` |
| `review-loop` | Reviewer → verdict → fixer → repeat until SHIP or max cycles |

### Phase Definition Reference

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `name` | string | yes | Phase identifier |
| `mode` | string | yes | `single`, `parallel`, `gate`, or `review-loop` |
| `description` | string | no | Injected into agent prompt |
| `role` | string | no | Agent type to spawn (e.g. `builder`, `scout`) |
| `contextFrom` | string | no | Phase name whose handoff provides context |
| `fixRole` | string | no | Agent type for fixes in `review-loop` mode |
| `maxCycles` | number | no | Max review-fix cycles (default: 3) |
| `taskSource` | string | no | Phase whose handoff seeds tasks for `parallel` mode |

### Workflow Data Flow

Each workflow run creates a directory at `.pi/flow/<workflow-id>/`:

```
.pi/flow/flow-abc12345/
├── state.json              # Current workflow state (phase, tokens, agents)
├── events.jsonl            # Append-only event log
├── handoffs/
│   ├── 001-scout.json      # Phase 1 agent output
│   ├── 002-planner.json    # Phase 2 agent output
│   └── 003-reviewer.json   # Phase 3 agent output
└── tasks/                  # Parallel phase tasks (if any)
    ├── task-1.json
    └── task-2.json
```

**Handoffs** are how agents pass context between phases. Each handoff contains:
- `summary` — First line of agent output
- `findings` — Full agent output
- `filesAnalyzed` / `filesModified` — File tracking
- `verdict` / `issues` — Review-specific fields

### Review Verdicts

In `review-loop` phases, the reviewer agent outputs a structured verdict:

```markdown
## Verdict: SHIP
All tests pass, code follows existing patterns.

## Issues
- (none)

## Suggestions
- Consider adding an index on the users.email column
```

| Verdict | Effect |
|---------|--------|
| `SHIP` | Phase completes successfully |
| `NEEDS_WORK` | Fix agent addresses issues, then re-review |
| `MAJOR_RETHINK` | Phase escalates (returns to orchestrator) |

### Crash Recovery

If pi exits mid-workflow:

1. On next `session_start`, the extension reads the bookmark from `appendEntry("pi-flow:active", ...)`
2. Loads `state.json` — if `completedAt` is missing, the workflow was interrupted
3. Detects stalled agents (running > 5 minutes) and warns the user
4. User says "resume workflow" → `Workflow({ action: "continue" })` picks up from the interrupted phase
5. `buildContinuationPrompt` provides the new agent with context from the previous attempt

## Commands

| Command | Description |
|---------|-------------|
| `/agents` | Interactive agent management: list, create, edit, disable, settings |
| `/flow` | View active workflow progress, abort |

## Architecture

```
src/
├── agents/              # Sub-agent system
│   ├── manager.ts       # Agent lifecycle, queue, concurrency
│   ├── runner.ts        # Session execution, turn limits, abort
│   ├── session.ts       # Tool resolution, memory, model, prompt building
│   ├── registry.ts      # Merged agent type registry (defaults + custom)
│   ├── custom.ts        # Load .md agent configs
│   ├── defaults.ts      # Embedded default agents
│   ├── batch.ts         # Smart join batching
│   ├── lifecycle.ts     # Completion routing, group delivery
│   ├── notification.ts  # Debounced completion notifications
│   └── tools/           # LLM-callable tools (Agent, get_subagent_result, steer_subagent)
├── config/              # Agent configuration resolution
│   ├── invocation.ts    # Merge agent config + tool params
│   ├── model-resolver.ts # Fuzzy model name resolution
│   ├── prompts.ts       # System prompt builder (append/replace)
│   └── skill-loader.ts  # Preload named skills into prompt
├── extension/           # pi extension integration
│   ├── command/         # /agents interactive menu
│   ├── group-join.ts    # Group completion notifications
│   ├── helpers.ts       # Shared formatting + notification builders
│   ├── activity-tracker.ts # Live tool/turn/token tracking
│   └── rpc.ts           # Cross-extension RPC (spawn/stop/ping)
├── infra/               # Infrastructure
│   ├── context.ts       # Parent conversation extraction
│   ├── env.ts           # Git/platform detection
│   ├── memory.ts        # Persistent agent memory directories
│   ├── output-file.ts   # JSONL transcript streaming
│   └── worktree.ts      # Git worktree isolation
├── ui/                  # TUI rendering
│   ├── formatters.ts    # Pure format helpers + shared types
│   ├── widget.ts        # Persistent agent status widget
│   ├── widget-render.ts # Widget line rendering (pure)
│   ├── viewer.ts        # Conversation overlay component
│   └── viewer-content.ts # Conversation line rendering (pure)
├── workflow/            # Workflow orchestration engine
│   ├── types.ts         # All workflow type definitions
│   ├── loader.ts        # Discover + parse workflow .md files
│   ├── pipeline.ts      # Phase state machine (pure)
│   ├── executor.ts      # Phase execution + advancement
│   ├── executor-helpers.ts # Handoff resolution, token accumulation
│   ├── phase-dispatch.ts # Route to phase handler by mode
│   ├── phase-single.ts  # Single agent phase
│   ├── phase-parallel.ts # Parallel task phase
│   ├── phase-review.ts  # Review-fix loop phase
│   ├── phase-gate.ts    # Approval gate phase
│   ├── prompt-builder.ts # Build agent prompts from workflow context
│   ├── store.ts         # Atomic file I/O (state, handoffs, events)
│   ├── task-store.ts    # Task CRUD for parallel phases
│   ├── verdict.ts       # Parse review output → verdict
│   ├── recovery.ts      # Crash recovery + continuation prompts
│   ├── progress.ts      # Widget + status bar rendering
│   ├── helpers.ts       # Shared workflow helpers
│   ├── flow-command.ts  # /flow command handler
│   └── integration.ts   # Wire everything into pi's extension API
├── types.ts             # Shared types (AgentConfig, AgentRecord, etc.)
└── index.ts             # Extension entry point
```

## Cross-Extension API

Other pi extensions can interact with pi-flow via the event bus:

```typescript
// Spawn an agent from another extension
const requestId = crypto.randomUUID();
pi.events.emit("subagents:rpc:spawn", {
  requestId,
  type: "builder",
  prompt: "Fix the linting errors",
  options: { description: "Fix lint", isBackground: true },
});

// Listen for reply
pi.events.on(`subagents:rpc:spawn:reply:${requestId}`, (reply) => {
  if (reply.success) console.log("Agent ID:", reply.data.id);
});
```

**RPC channels:**
- `subagents:rpc:ping` → `{ version: 2 }`
- `subagents:rpc:spawn` → `{ id: string }`
- `subagents:rpc:stop` → `void`

**Events emitted:**
- `subagents:ready` — Extension loaded
- `subagents:created` — Agent spawned
- `subagents:started` — Agent session started
- `subagents:completed` — Agent finished successfully
- `subagents:failed` — Agent errored/aborted
- `subagents:steered` — Steering message sent

## License

MIT
