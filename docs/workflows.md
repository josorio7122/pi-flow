# Workflow Configuration Guide

## Overview

Workflows orchestrate multiple agents through defined phases. Each phase spawns a specialized agent, collects its output as a **handoff**, and passes context to the next phase.

Workflows are defined as `.md` files — the same format as agents.

## Discovery Hierarchy

1. **Project** (highest): `.pi/workflows/<name>.md`
2. **Global**: `~/.pi/agent/workflows/<name>.md`
3. **Built-in** (lowest): bundled in the extension's `workflows/` directory

## File Format

```markdown
---
name: my-workflow
description: What this workflow does
triggers:
  - when the user says this
  - or this

phases:
  - name: scout
    role: scout
    mode: single
    description: Explore the codebase

  - name: approve
    mode: gate
    description: Review findings before proceeding

  - name: build
    role: builder
    mode: single
    description: Implement the changes
    contextFrom: scout

config:
  tokenLimit: 150000
---

Instructions injected into every agent prompt.
```

## Phase Modes

### `single`

Spawn one agent. Wait for completion. Write handoff.

```yaml
- name: scout
  role: scout
  mode: single
  description: Explore and map the codebase
```

The `role` field maps to an agent type (e.g., `scout` → `agents/scout.md`). If the role doesn't match a custom agent, `general-purpose` is used as fallback.

### `gate`

Pause execution. The user sees the results from previous phases and must approve before continuing.

```yaml
- name: approve-plan
  mode: gate
  description: Review the plan before writing code
```

The user approves via `Workflow({ action: "continue" })` or says "continue the workflow."

### `review-loop`

Alternates between a **reviewer** and a **fixer** until the reviewer says SHIP or max cycles are reached.

```yaml
- name: review
  role: reviewer
  mode: review-loop
  description: Review implementation quality
  fixRole: builder
  maxCycles: 3
  contextFrom: build
```

The reviewer must output a structured verdict:

```markdown
## Verdict: SHIP|NEEDS_WORK|MAJOR_RETHINK

Explanation here.

## Issues
- Description of issue 1
- Description of issue 2

## Suggestions
- Optional improvement suggestions
```

| Verdict | What happens |
|---------|-------------|
| `SHIP` | Phase completes, workflow advances |
| `NEEDS_WORK` | Fixer agent addresses issues, then re-review |
| `MAJOR_RETHINK` | Phase escalates — workflow reports stuck |

**Stuck detection:** If the same issues reappear across cycles, the workflow detects it's stuck and stops looping.

### `parallel`

Parse tasks from the previous phase's handoff and run them concurrently.

```yaml
- name: implement
  role: builder
  mode: parallel
  description: Implement each planned task
  contextFrom: plan
```

Tasks are extracted from the previous handoff's `findings` field — each top-level bullet point becomes a task:

```markdown
- Add input validation to /users endpoint
- Create rate limiter middleware
- Update API documentation
```

Sub-bullets (indented) are ignored. Each task gets its own agent. Tasks with dependencies execute in waves.

## Context Passing

### `contextFrom`

Specifies which phase's handoff provides context to this phase's agent.

```yaml
- name: build
  role: builder
  mode: single
  contextFrom: plan    # Builder receives planner's findings
```

The handoff includes:
- **Summary** — First line of the previous agent's output
- **Findings** — Full output text
- **Files analyzed/modified** — File tracking
- **Issues** — Review-specific structured issues

### Orchestrator Instructions

The markdown body (after the `---` frontmatter) becomes `orchestratorInstructions`. This text is injected into **every** agent prompt in the workflow, providing shared context.

Use it for:
- Project-specific conventions
- Architecture constraints
- Testing requirements
- Style guidelines

## Configuration

### `config.tokenLimit` (number, default: 100,000)

Total token budget across all phases. When reached, the workflow completes with `exitReason: "token_limit"`. Tokens are tracked per-phase and accumulated after each phase completes.

### `config.maxTurnsPerAgent` (number, optional)

Per-agent turn limit. Overrides the default from `/agents > Settings`.

## Runtime State

Each workflow run creates a directory at `.pi/flow/<workflow-id>/`:

```
.pi/flow/flow-abc12345/
├── state.json              # Mutable workflow state
├── events.jsonl            # Append-only event log
├── handoffs/
│   ├── 001-scout.json      # Agent outputs in order
│   └── 002-builder.json
└── tasks/                  # Parallel phase tasks
    ├── task-1.json
    └── task-2.json
```

### state.json

Tracks: current phase, phase results (status/timing), token budget, active/completed agents, review cycle count, exit reason.

### events.jsonl

Append-only log of all workflow events:
- `workflow_start`, `workflow_complete`, `workflow_resumed`
- `phase_start`, `phase_complete`
- `agent_start`, `agent_complete`, `agent_error`
- `handoff_written`
- `approval` (gate decisions)
- `review_verdict`
- `token_update`

### Handoff files

JSON files written after each agent completes. Named `NNN-<role>.json`. The next phase reads these for context.

## Crash Recovery

If pi exits mid-workflow:

1. On restart, the extension reads the recovery bookmark from the session entries
2. Loads `state.json` — if no `completedAt`, the workflow was interrupted
3. Warns about stalled agents (running > 5 minutes)
4. The user says "resume workflow" to continue from the interrupted phase
5. The new agent receives a continuation prompt with context from the previous attempt, avoiding duplicate work

## Built-in Workflows

### `research`
Single-phase: scout explores and reports findings.

### `explore`
Two phases: scout explores, then planner creates an action plan based on findings.

### `fix`
Four phases: scout diagnoses → gate (approve fix approach) → builder implements → reviewer checks.

### `feature`
Five phases: planner designs → gate (approve plan) → test-writer writes failing tests → builder implements → reviewer checks (with fix loop).

## Examples

### Simple two-phase workflow
```markdown
---
name: document
description: Analyze code and generate documentation
triggers:
  - document this
  - write docs

phases:
  - name: analyze
    role: scout
    mode: single
    description: Map all public APIs and their usage

  - name: write-docs
    role: builder
    mode: single
    description: Generate API documentation
    contextFrom: analyze

config:
  tokenLimit: 80000
---

Focus on public-facing APIs. Use JSDoc/docstring format
matching existing project conventions.
```

### Workflow with parallel execution
```markdown
---
name: refactor
description: Plan refactoring tasks and execute them in parallel
triggers:
  - refactor this module

phases:
  - name: plan
    role: planner
    mode: single
    description: Identify refactoring tasks as a bullet list

  - name: approve
    mode: gate
    description: Review plan before executing

  - name: execute
    role: builder
    mode: parallel
    description: Execute each refactoring task
    contextFrom: plan

  - name: review
    role: reviewer
    mode: review-loop
    fixRole: builder
    maxCycles: 2
    contextFrom: execute

config:
  tokenLimit: 200000
---

Each refactoring task should be independent.
Run tests after every change.
```
