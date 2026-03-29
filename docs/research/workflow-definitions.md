# Workflow Definitions as Files

> Workflows are `.md` files with YAML frontmatter — same pattern as agent configs.
> Drop a file, get a workflow. The engine reads the definition and executes it generically.

---

## Why Files

| Concern | Hardcoded TypeScript | File-based definitions |
|---------|---------------------|----------------------|
| Adding a workflow | Edit source, rebuild, republish | Drop a `.md` file |
| Customizing for a project | Fork the extension | Override in `.pi/workflows/` |
| Sharing workflows | Copy-paste code | Share the `.md` file |
| LLM understanding | Must read source code | Reads the definition directly |
| Consistency | Different pattern from agents | Same pattern as `.pi/agents/*.md` |

---

## Discovery Hierarchy

Same as agent configs — higher priority wins by name:

```
1. Project:   <cwd>/.pi/workflows/*.md    (highest — project-specific)
2. Global:    ~/.pi/agent/workflows/*.md   (user-global)
3. Built-in:  <extension>/workflows/*.md   (shipped with pi-flow)
```

Project-level workflows override global, which override built-in. The loader uses the existing `parseFrontmatter` from pi-coding-agent (same as `custom.ts` uses).

---

## File Format

```yaml
---
name: fix
description: Scout for issues, fix them, review the changes
# Triggers help the LLM router decide when to use this workflow.
# The orchestrator LLM reads these — they're guidance, not exact matching.
triggers:
  - fix, remove, or refactor specific patterns in the codebase
  - simple targeted changes across multiple files
  - cleanup tasks with clear acceptance criteria

# Phases execute in order. Each phase has a role (agent type to spawn)
# and a mode (how it executes).
phases:
  - name: scout
    role: scout
    mode: single           # one agent, foreground, wait for result
    description: Analyze the codebase and report what needs to change

  - name: approve
    mode: gate             # pause for user approval before continuing
    description: Review scout findings and approve the fix plan

  - name: build
    role: builder
    mode: single
    context_from: scout    # pass scout's handoff as context
    description: Implement the changes identified by the scout

  - name: review
    role: reviewer
    mode: review-loop      # special mode: review → fix → re-review cycle
    context_from: build    # review the builder's changes
    fix_role: builder      # who fixes issues (spawned on NEEDS_WORK)
    max_cycles: 3          # max review-fix iterations
    description: Check the changes and iterate until clean

# Optional defaults
config:
  cost_limit: 5.0
  max_turns_per_agent: 50
---

Optional orchestrator instructions for this workflow.
This body text is included in the orchestrator's context when running
this workflow, providing additional guidance beyond the phase structure.
```

---

## Phase Modes

The engine needs to know HOW to execute each phase. Four modes:

| Mode | What happens | Example |
|------|-------------|---------|
| `single` | Spawn one agent (foreground), wait for result, create handoff | Scout reads codebase |
| `parallel` | Spawn N agents (background), wait for all, merge handoffs | Multiple builders for different tasks |
| `gate` | Pause and ask user for approval. Workflow stops on reject. | "Scout found X. Proceed?" |
| `review-loop` | Spawn reviewer → parse verdict → if NEEDS_WORK spawn fix_role → re-review → repeat until SHIP or max_cycles | Code review with fix iterations |

These 4 modes cover all our workflows:

| Workflow | Phases |
|----------|--------|
| **research** | `single` (probe) |
| **explore** | `single` (explorer) |
| **fix** | `single` (scout) → `gate` → `single` (builder) → `review-loop` |
| **feature** | `single` (clarifier) → `gate` → `single` (planner) → `single` (test-writer) → `gate` → `parallel` (builders) → `review-loop` |

---

## Built-in Workflow Definitions

### `workflows/research.md`

```yaml
---
name: research
description: Research or verify something — database queries, web search, documentation lookup
triggers:
  - research, look up, or verify external information
  - query databases, APIs, or documentation
  - answer questions that require live data or current docs
phases:
  - name: probe
    role: probe
    mode: single
    description: Research the question and report findings
config:
  cost_limit: 2.0
---
```

### `workflows/explore.md`

```yaml
---
name: explore
description: Understand code — read, analyze, and explain a codebase area
triggers:
  - understand, explain, or analyze how code works
  - map dependencies or trace data flow
  - produce a summary of a codebase area before deciding what to do
phases:
  - name: explore
    role: explorer
    mode: single
    description: Deep-read the codebase area and produce an understanding report
config:
  cost_limit: 3.0
---
```

### `workflows/fix.md`

```yaml
---
name: fix
description: Scout for issues, fix them, review the changes
triggers:
  - fix, remove, or refactor specific patterns across the codebase
  - simple targeted changes with clear criteria
  - cleanup or migration tasks
phases:
  - name: scout
    role: scout
    mode: single
    description: Analyze the codebase and identify what needs to change

  - name: approve
    mode: gate
    description: Present scout findings to user for approval

  - name: build
    role: builder
    mode: single
    context_from: scout
    description: Implement the fixes identified by the scout

  - name: review
    role: reviewer
    mode: review-loop
    context_from: build
    fix_role: builder
    max_cycles: 3
    description: Review changes and iterate until clean
config:
  cost_limit: 5.0
---
```

### `workflows/feature.md`

```yaml
---
name: feature
description: Build a new feature from a vague idea — clarify requirements, plan tasks, write tests, implement, review
triggers:
  - build a new feature, add functionality, implement a capability
  - vague or complex requests that need clarification first
  - multi-file changes that need planning and testing
phases:
  - name: clarify
    role: clarifier
    mode: single
    description: Ask the user questions to build a clear spec (SDD approach)

  - name: approve-spec
    mode: gate
    description: User reviews and approves the clarified spec

  - name: plan
    role: planner
    mode: single
    context_from: clarify
    description: Break the spec into tasks with dependencies

  - name: test
    role: test-writer
    mode: single
    context_from: plan
    description: Write failing tests for the planned tasks (red phase)

  - name: approve-plan
    mode: gate
    description: User reviews plan and tests before implementation

  - name: build
    role: builder
    mode: parallel
    context_from: plan
    task_source: plan      # reads tasks from plan phase handoff
    description: Implement tasks to make tests pass (green phase)

  - name: review
    role: reviewer
    mode: review-loop
    context_from: build
    fix_role: builder
    max_cycles: 5
    description: Review all changes against spec and plan
config:
  cost_limit: 20.0
---

## Orchestrator Guidance

For the clarify phase, use SDD (Spec-Driven Design):
- Ask questions one at a time, wait for answers
- Focus on acceptance criteria and edge cases
- Produce a structured spec, not just notes

For the test phase, enforce TDD:
- Tests must fail before implementation (red)
- Run tests to confirm failure
- Builder must make them pass (green)

For parallel build, use task dependencies:
- Independent tasks run concurrently (background agents)
- Dependent tasks wait for prerequisites
- Each builder gets one task + context from planner
```

---

## What Changes in the Tooling

### New: `src/workflow/loader.ts` (~100 lines)

Discovers and parses workflow `.md` files. Same pattern as `agents/custom.ts`.

```ts
interface WorkflowDefinition {
  name: string
  description: string
  triggers: string[]
  phases: PhaseDefinition[]
  config: WorkflowConfig
  orchestratorInstructions: string    // the .md body
  source: "builtin" | "global" | "project"
}

interface PhaseDefinition {
  name: string
  role?: AgentRole                     // undefined for gate phases
  mode: "single" | "parallel" | "gate" | "review-loop"
  description: string
  contextFrom?: string                 // phase name to get handoff from
  fixRole?: AgentRole                  // for review-loop mode
  maxCycles?: number                   // for review-loop mode
  taskSource?: string                  // for parallel mode — which phase provides task list
}

interface WorkflowConfig {
  costLimit: number
  maxTurnsPerAgent?: number
}

function loadWorkflowDefinitions(cwd: string): Map<string, WorkflowDefinition>
function loadBuiltinWorkflows(): Map<string, WorkflowDefinition>
```

### Changes to `pipeline.ts`

Instead of hardcoded phase lists, the pipeline reads `WorkflowDefinition.phases`:

```ts
function createWorkflowState(definition: WorkflowDefinition, description: string): WorkflowState
// Initializes phases from definition.phases, not from a hardcoded WorkflowType→phases mapping
```

### Changes to `types.ts`

- `WorkflowPhase` becomes a string (not a union) — phases are defined by the workflow file
- `WorkflowState.phases` is `Record<string, PhaseResult>` — keyed by phase name from definition
- Add `WorkflowDefinition` and `PhaseDefinition` types

### Changes to router

The router reads all loaded `WorkflowDefinition` objects and their `triggers` to build the tool description. The LLM sees:

```
Available workflows:
- research: Research or verify something...
  triggers: research, look up, or verify external information; ...
- explore: Understand code...
  triggers: understand, explain, or analyze how code works; ...
- fix: Scout for issues, fix them, review...
  triggers: fix, remove, or refactor specific patterns; ...
- feature: Build a new feature...
  triggers: build a new feature, add functionality; ...
```

### No changes to `store.ts`, `verdict.ts`, `recovery.ts`, `progress.ts`, `tool-guard.ts`

These are generic — they work with `WorkflowState` and `AgentHandoff` regardless of which workflow defined them.

---

## Updated File Estimates

| File | Lines | Change from previous plan |
|------|-------|--------------------------|
| `types.ts` | ~150 | +20 (WorkflowDefinition, PhaseDefinition) |
| `loader.ts` | ~100 | NEW (workflow file discovery + parsing) |
| `store.ts` | ~120 | No change |
| `pipeline.ts` | ~180 | No change (already generic — just reads from definition) |
| `verdict.ts` | ~55 | No change |
| `recovery.ts` | ~120 | No change |
| `progress.ts` | ~120 | No change |
| `tool-guard.ts` | ~70 | No change |
| **Total** | **~915** | +120 from loader + types growth |

Plus ~4 workflow `.md` files (not code — definitions).

---

## Custom Workflow Example

A user building a Django project drops this in `.pi/workflows/django-feature.md`:

```yaml
---
name: django-feature
description: Build a Django feature with migrations, tests, and API review
triggers:
  - add a Django model, view, or API endpoint
  - database changes requiring migrations
phases:
  - name: explore
    role: explorer
    mode: single
    description: Understand current Django app structure, models, and URL patterns

  - name: plan
    role: planner
    mode: single
    context_from: explore
    description: Plan models, views, serializers, migrations, and tests

  - name: approve
    mode: gate
    description: Review the plan before implementation

  - name: build
    role: builder
    mode: single
    context_from: plan
    description: Implement models, migrations, views, serializers, and tests

  - name: review
    role: reviewer
    mode: review-loop
    context_from: build
    fix_role: builder
    max_cycles: 3
    description: Check migrations, model correctness, API contracts, and test coverage
config:
  cost_limit: 10.0
---

## Django-Specific Instructions

- Always run makemigrations after model changes
- Use black for formatting
- Run tests with pytest inside Docker
- Follow the project's AGENTS.md conventions
```

The engine discovers this, adds it to the router, and the LLM can trigger it when the user says "add a new Django model for invoices."
