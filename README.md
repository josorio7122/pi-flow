# pi-flow

A pi extension with two generic engines: **autonomous sub-agents** and **declarative workflows**. Both are fully driven by `.md` configuration files — no TypeScript needed to add new agent types or workflow definitions.

## Tools

| Tool | Description |
|------|-------------|
| `Agent` | Spawn a sub-agent (foreground or background) |
| `get_subagent_result` | Check status or retrieve results from a background agent |
| `steer_subagent` | Send a steering message to a running agent |
| `Workflow` | Start, continue, or check status of a multi-phase workflow |

## Commands

| Command | Description |
|---------|-------------|
| `/agents` | Manage agent types, view running agents, settings |
| `/flow` | View workflow progress, abort active workflows |

---

## Agent Definitions

Agents are defined as `.md` files with YAML frontmatter and a system prompt body.

### Discovery

| Priority | Location | Scope |
|----------|----------|-------|
| 1 (highest) | `<project>/.pi/agents/<name>.md` | Project-specific |
| 2 | `~/.pi/agent/agents/<name>.md` | Global (all projects) |
| 3 (lowest) | Built-in defaults | `general-purpose`, `Explore`, `Plan` |

Project agents override global agents with the same name. Creating a `.md` with the same name as a built-in overrides it.

### File Format

```markdown
---
# Required
description: One-line description shown in UI

# Tools (default: all built-in tools)
tools: read, bash, edit, write, grep, find, ls   # comma-separated, or "none", or "all"
disallowed_tools: Agent, steer_subagent           # tools to block even if otherwise available

# Model & thinking (default: inherit from parent)
model: anthropic/claude-sonnet-4-6                # provider/modelId
thinking: medium                                  # off, minimal, low, medium, high, xhigh

# Execution
max_turns: 30                                     # 0 or omit for unlimited
run_in_background: false                          # default: false
isolated: false                                   # true = no extension/MCP tools
isolation: worktree                               # run in isolated git worktree

# Prompt mode
prompt_mode: replace                              # "replace" = body IS the system prompt
                                                  # "append" = body appended to default prompt

# Extensions & skills (default: true = inherit all)
extensions: true                                  # true, false, or comma-separated names
skills: true                                      # true, false, or comma-separated skill names

# Context
inherit_context: false                            # true = fork parent conversation into agent
memory: project                                   # "user" (global), "project", "local" (gitignored)

# Display
display_name: Scout                               # name shown in UI (default: filename)
enabled: true                                     # set false to disable without deleting
---

Your system prompt goes here. This is the instruction set for the agent.

You are a code review agent. Analyze the codebase and report findings...
```

All frontmatter fields are optional. Omitted fields use defaults. The body (below `---`) is the system prompt.

### Examples

**Read-only explorer:**
```markdown
---
description: Deep-reads codebase, produces understanding reports
tools: read, bash, grep, find, ls
prompt_mode: append
---

Focus on understanding architecture and relationships between modules.
Do not modify any files.
```

**Background builder with worktree isolation:**
```markdown
---
description: Implements code changes in an isolated worktree
tools: read, bash, edit, write, grep, find, ls
run_in_background: true
isolation: worktree
thinking: high
max_turns: 50
---

You are a code implementation agent. Follow the plan exactly.
Run tests after every change.
```

---

## Workflow Definitions

Workflows are multi-phase orchestrations defined as `.md` files. The engine reads the phase definitions and executes them generically — no TypeScript per workflow.

### Discovery

| Priority | Location | Scope |
|----------|----------|-------|
| 1 (highest) | `<project>/.pi/workflows/<name>.md` | Project-specific |
| 2 | `~/.pi/agent/workflows/<name>.md` | Global (all projects) |
| 3 (lowest) | `<extension>/workflows/<name>.md` | Built-in |

### File Format

```markdown
---
name: fix
description: Scout codebase, get approval, fix issues, review changes
triggers:
  - fix a bug or issue
  - scout and repair

phases:
  - name: scout
    role: scout           # agent type to spawn (must exist in .pi/agents/ or built-in)
    mode: single          # execution mode (see below)
    description: Scan the codebase for the reported issue

  - name: approve
    mode: gate            # pause for user approval
    description: Review scout findings before proceeding

  - name: build
    role: builder
    mode: single
    description: Fix the identified issues
    contextFrom: scout    # feed scout's handoff into builder's prompt

  - name: review
    role: reviewer
    mode: review-loop     # reviewer → fix → reviewer → ... until SHIP
    description: Review the changes
    fixRole: builder      # agent to spawn for fixes
    maxCycles: 3          # max review-fix iterations

config:
  tokenLimit: 100000      # total token budget across all phases
  maxTurnsPerAgent: 30    # per-agent turn limit
---

Additional orchestrator instructions go here.
These are included in every agent's prompt for this workflow.
```

### Phase Modes

| Mode | Behavior |
|------|----------|
| `single` | Spawn one agent with the specified `role`, wait for completion, write handoff, advance to next phase |
| `gate` | Pause execution. Returns to user for approval. Use `Workflow({ action: "continue" })` to proceed |
| `review-loop` | Spawn `role` as reviewer → parse verdict (SHIP/NEEDS_WORK/MAJOR_RETHINK) → if NEEDS_WORK, spawn `fixRole` → repeat up to `maxCycles` |
| `parallel` | Read tasks from task store, spawn agents for each ready task (respecting dependencies), collect results |

### Phase Fields

| Field | Required | Description |
|-------|----------|-------------|
| `name` | Yes | Unique phase identifier |
| `mode` | Yes | `single`, `gate`, `review-loop`, or `parallel` |
| `role` | For `single`, `review-loop`, `parallel` | Agent type to spawn |
| `description` | No | Included in the agent's prompt |
| `contextFrom` | No | Name of a previous phase — its handoff output is fed into this phase's prompt |
| `fixRole` | For `review-loop` | Agent type to spawn for fixes when reviewer says NEEDS_WORK |
| `maxCycles` | For `review-loop` | Maximum review-fix iterations (default: 3) |
| `taskSource` | For `parallel` | Where to read tasks from |

### Examples

**Simple research workflow (1 phase):**
```markdown
---
name: research
description: Research a topic or verify information
triggers:
  - research something
  - look up information
phases:
  - name: probe
    role: probe
    mode: single
    description: Research the question thoroughly
config:
  tokenLimit: 50000
---
```

**Full feature workflow (TDD with review loop):**
```markdown
---
name: feature
description: Build a feature with planning, TDD, and code review
triggers:
  - build a new feature
  - implement with TDD
phases:
  - name: plan
    role: planner
    mode: single
    description: Analyze requirements and create implementation plan

  - name: approve-plan
    mode: gate
    description: Review the plan before implementation

  - name: test
    role: test-writer
    mode: single
    description: Write failing tests from the plan
    contextFrom: plan

  - name: build
    role: builder
    mode: single
    description: Implement code to make tests pass
    contextFrom: test

  - name: review
    role: reviewer
    mode: review-loop
    description: Review implementation against plan and tests
    fixRole: builder
    maxCycles: 3
    contextFrom: build

config:
  tokenLimit: 200000
---

Follow TDD strictly: tests must fail before implementation, pass after.
```

### How Workflows Execute

1. The LLM calls `Workflow({ action: "start", workflow_type: "fix", description: "Fix the auth bug" })`
2. The engine creates workflow state in `.pi/flow/<id>/`
3. For each phase, the engine:
   - Reads the phase definition from the `.md` file
   - Builds a prompt from the workflow context + previous phase's handoff
   - Spawns the agent via the sub-agent system
   - Collects the result, writes a handoff file
   - Advances to the next phase
4. Gate phases pause and wait for `Workflow({ action: "continue" })`
5. Review-loop phases run the reviewer → parser → fixer cycle automatically
6. When all phases complete, the workflow is marked done

### Runtime State

Each workflow run creates:
```
.pi/flow/<workflow-id>/
├── state.json          # Current workflow state (phase, tokens, agents)
├── events.jsonl        # Append-only event timeline
├── handoffs/           # Agent output files (001-scout.json, 002-builder.json, ...)
└── tasks/              # Task files for parallel phases
```

---

## Project Structure

```
src/
├── agents/              # Sub-agent engine
│   ├── tools/           #   Tool registrations (Agent, get_subagent_result, steer)
│   ├── manager.ts       #   Agent lifecycle — spawn, queue, resume, abort
│   ├── runner.ts        #   Execution loop — run, resume, steer
│   ├── session.ts       #   Session builder — tools, memory, skills, prompt, model
│   ├── registry.ts      #   Agent type configs + tool registry
│   ├── custom.ts        #   Load .md agent definitions from disk
│   ├── defaults.ts      #   Built-in agent types
│   ├── batch.ts         #   Smart join mode batching
│   ├── lifecycle.ts     #   Completion routing + event emission
│   └── notification.ts  #   Debounced completion notifications
├── workflow/            # Workflow engine
│   ├── executor.ts      #   Generic phase executor — dispatches by mode
│   ├── phase-single.ts  #   Single-agent phase handler
│   ├── phase-review.ts  #   Review-fix loop handler
│   ├── phase-parallel.ts#   Parallel task handler
│   ├── phase-gate.ts    #   Approval gate handler
│   ├── prompt-builder.ts#   Build prompts from handoffs + context
│   ├── pipeline.ts      #   State machine — phase transitions, token tracking
│   ├── verdict.ts       #   Parse SHIP/NEEDS_WORK/MAJOR_RETHINK from reviewer output
│   ├── store.ts         #   File I/O — state, handoffs, events (atomic writes)
│   ├── task-store.ts    #   Task CRUD with dependency resolution
│   ├── loader.ts        #   Discover workflow .md files from disk
│   ├── recovery.ts      #   Crash recovery — stalled detection, continuation prompts
│   ├── progress.ts      #   Widget rendering — progress lines, status bar
│   ├── integration.ts   #   Wire to pi — Workflow tool, /flow command, hooks
│   ├── helpers.ts       #   Shared helpers for integration
│   └── types.ts         #   All workflow type definitions
├── config/              # Input resolution
│   ├── invocation.ts    #   Resolve agent invocation config from params
│   ├── model-resolver.ts#   Fuzzy model name resolution
│   ├── prompts.ts       #   System prompt builder
│   └── skill-loader.ts  #   Skill preloading
├── extension/           # pi extension wiring
│   ├── command/         #   /agents interactive menu (views, wizards, settings)
│   ├── group-join.ts    #   Smart grouping for concurrent agent completions
│   ├── helpers.ts       #   Shared tool execution helpers
│   ├── activity-tracker.ts # Agent activity state tracking
│   └── rpc.ts           #   Cross-extension RPC handlers
├── infra/               # OS/filesystem
│   ├── context.ts       #   Parent context extraction
│   ├── env.ts           #   Environment detection
│   ├── memory.ts        #   Persistent agent memory
│   ├── output-file.ts   #   Transcript streaming
│   └── worktree.ts      #   Git worktree management
├── ui/                  # TUI components
│   ├── widget.ts        #   Live agent widget
│   ├── widget-render.ts #   Widget render helpers (pure)
│   ├── viewer.ts        #   Conversation viewer overlay
│   ├── viewer-content.ts#   Conversation content builder (pure)
│   └── formatters.ts    #   Shared formatting utilities
├── index.ts             #   Extension entry point
└── types.ts             #   Shared types
```

## Setup

```bash
npm install
```

## Development

```bash
npm test           # run tests
npm run typecheck   # type check
npm run lint        # lint (biome)
npm run format      # format (biome)
npm run check       # all of the above
npm run build       # compile
```
