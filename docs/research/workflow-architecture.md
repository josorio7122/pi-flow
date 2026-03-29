# Workflow Architecture — State, Comms, Resumability

> How the workflow engine persists state, passes context between agents, recovers from failures, and provides traceability.

---

## The Problem

When pi-flow runs a W3 workflow (scout → approve → build → review → fix loop), several things can go wrong:
1. Pi crashes mid-build — how do we resume?
2. The builder needs the scout's findings — how does it get them?
3. The user wants to see what happened — where's the audit trail?
4. The reviewer finds issues — how does the builder know what to fix?
5. The session gets compacted — is workflow state lost?

We need a persistence layer that is:
- **Durable** — survives pi crashes, session switches, compaction
- **Inspectable** — user can see exactly what happened and why
- **Efficient** — agents don't re-read the entire codebase; they get focused context from previous agents
- **Recoverable** — on restart, we know exactly where we were and can continue

---

## Two-Layer Persistence

### Layer 1: Session Entries (`appendEntry`) — the recovery bookmark

`pi.appendEntry(type, data)` writes to pi's session tree. It survives session switches, forks, and tree navigation. It does NOT get sent to the LLM (it's metadata, not conversation).

**We use it for ONE thing: a pointer to the active workflow.**

```ts
pi.appendEntry("pi-flow:active", {
  workflowId: "flow-a1b2c3",
  workflowType: "fix",
  workflowDir: ".pi/flow/flow-a1b2c3",
  startedAt: "2026-03-29T10:00:00Z",
  currentPhase: "build",
})
```

On `session_start`, we scan entries for the latest `pi-flow:active` → find the workflow dir → load full state from files. This is how pi-planner does it (simple, proven).

**Why not store everything in appendEntry?**
- `appendEntry` is append-only — can't update phase status in place
- Agent outputs can be large (10K+ tokens) — doesn't belong in session metadata
- No way to query/filter entries efficiently

### Layer 2: Files (`.pi/flow/<id>/`) — the full state

Each workflow run gets a directory. Files are the source of truth for all workflow state.

```
.pi/flow/
└── flow-a1b2c3/
    ├── state.json           # Current workflow state (phase, cost, config)
    ├── events.jsonl         # Append-only event log (traceability)
    ├── handoffs/
    │   ├── 01-scout.json    # Scout → orchestrator handoff
    │   ├── 02-builder.json  # Builder → orchestrator handoff
    │   └── 03-reviewer.json # Reviewer → orchestrator handoff
    └── tasks/               # Only for W4 (feature workflow)
        ├── plan.json        # Task list with dependencies
        └── task-1.json      # Individual task state
```

**Why files, not just appendEntry?**
- Files are **mutable** — we can update `state.json` when phase changes
- Files are **inspectable** — user can `cat .pi/flow/flow-a1b2c3/state.json`
- Files are **large-capable** — handoff outputs can be big
- Files **survive compaction** — session compaction only affects conversation history, not disk files
- Files match what **every other multi-agent extension does** (pi-coordination, pi-messenger, pi-planner all use files)

**Atomic writes** — all file writes use temp + rename (like pi-messenger's `writeJson`):
```ts
const temp = `${path}.tmp-${process.pid}-${Date.now()}`
fs.writeFileSync(temp, JSON.stringify(data, null, 2))
fs.renameSync(temp, path)
```

---

## State Model

### `state.json` — the workflow snapshot

```ts
interface WorkflowState {
  // Identity
  id: string                              // "flow-a1b2c3"
  type: WorkflowType                      // "research" | "explore" | "fix" | "feature"
  description: string                     // User's original intent

  // Phase tracking
  currentPhase: WorkflowPhase
  phases: Record<WorkflowPhase, PhaseResult>
  
  // Review loop
  reviewCycle: number
  maxReviewCycles: number
  exitReason?: ExitReason                 // "clean" | "stuck" | "max_cycles" | "cost_limit" | "user_abort"

  // Cost
  cost: CostState

  // Timing
  startedAt: number
  completedAt?: number

  // Agent tracking
  activeAgents: ActiveAgent[]             // Currently running agents
  completedAgents: CompletedAgent[]       // Finished agents with summary
}

interface ActiveAgent {
  agentId: string                         // pi-flow's agent record ID
  role: AgentRole
  phase: WorkflowPhase
  startedAt: number
}

interface CompletedAgent {
  agentId: string
  role: AgentRole
  phase: WorkflowPhase
  handoffFile: string                     // "handoffs/01-scout.json"
  duration: number
  exitStatus: "completed" | "error" | "aborted"
  error?: string
}
```

**Updated after every phase transition, agent start, agent completion.** The orchestrator reads this on resume to know exactly where things stand.

---

## Agent Communication — The Handoff Protocol

Agents do NOT talk to each other directly. The orchestrator LLM is the hub. The flow is:

```
Orchestrator ──runs──→ Scout Agent
                          │
                          ▼
                     Scout completes
                          │
                          ▼
Orchestrator ←──reads── Handoff file (01-scout.json)
     │
     │ (builds prompt using scout's findings)
     │
     ▼
Orchestrator ──runs──→ Builder Agent (with scout context in prompt)
                          │
                          ▼
                     Builder completes
                          │
                          ▼
Orchestrator ←──reads── Handoff file (02-builder.json)
```

### Handoff File Format

```ts
interface AgentHandoff {
  // Who
  agentId: string
  role: AgentRole
  phase: WorkflowPhase

  // Output
  summary: string                         // 1-2 sentence summary (always present)
  findings: string                        // The agent's main output (can be large)
  
  // What happened
  filesAnalyzed: string[]                 // Files the agent read
  filesModified: string[]                 // Files the agent changed
  toolsUsed: number                       // Tool call count
  turnsUsed: number                       // Agentic turns

  // For review agents specifically
  verdict?: ReviewVerdict                 // "SHIP" | "NEEDS_WORK" | "MAJOR_RETHINK"
  issues?: ReviewIssue[]                  // Structured issues list

  // Timing & cost
  duration: number
  timestamp: number
}
```

### How the orchestrator builds the next agent's prompt

The orchestrator LLM gets the handoff as part of the tool result. It then:
1. Reads `summary` + `findings` from the handoff
2. Decides what the next agent needs to know (the LLM is smart about this)
3. Includes relevant context in the `prompt` parameter when calling the `Agent` tool

**This is efficient because:**
- The scout's full output is in the handoff file, but the orchestrator only passes RELEVANT parts to the builder
- The orchestrator summarizes/filters — the builder doesn't get 10K tokens of raw scout output
- If the orchestrator needs the full output later (e.g., for the reviewer), it's still on disk

### How handoffs are created

When an agent completes, the existing `onComplete` callback in `createAgentManager` fires. The workflow layer:
1. Captures `record.result` (the agent's response text)
2. Captures `record.toolUses`, duration, etc.
3. Writes the handoff file to `.pi/flow/<id>/handoffs/<NN>-<role>.json`
4. Updates `state.json` (move agent from `activeAgents` to `completedAgents`)
5. Returns the handoff to the orchestrator LLM as part of the tool result

---

## Event Log — Traceability

`events.jsonl` is append-only. Every significant action gets a line:

```jsonl
{"type":"workflow_start","workflowType":"fix","description":"remove any from codebase","ts":1711700000}
{"type":"phase_start","phase":"scout","ts":1711700001}
{"type":"agent_start","role":"scout","agentId":"abc123","ts":1711700001}
{"type":"agent_complete","role":"scout","agentId":"abc123","duration":45000,"toolUses":12,"ts":1711700046}
{"type":"handoff","from":"scout","to":"orchestrator","handoffFile":"handoffs/01-scout.json","ts":1711700046}
{"type":"phase_complete","phase":"scout","duration":45000,"ts":1711700046}
{"type":"approval","phase":"build","decision":"approved","ts":1711700060}
{"type":"phase_start","phase":"build","ts":1711700060}
{"type":"agent_start","role":"builder","agentId":"def456","ts":1711700061}
{"type":"agent_complete","role":"builder","agentId":"def456","duration":120000,"toolUses":34,"ts":1711700181}
{"type":"phase_start","phase":"review","ts":1711700182}
{"type":"agent_start","role":"reviewer","agentId":"ghi789","ts":1711700182}
{"type":"review_verdict","verdict":"NEEDS_WORK","issues":3,"ts":1711700220}
{"type":"review_cycle","cycle":1,"verdict":"NEEDS_WORK","ts":1711700220}
{"type":"agent_start","role":"builder","agentId":"jkl012","context":"fix 3 issues from review","ts":1711700221}
{"type":"agent_complete","role":"builder","agentId":"jkl012","duration":60000,"ts":1711700281}
{"type":"review_verdict","verdict":"SHIP","issues":0,"ts":1711700310}
{"type":"phase_complete","phase":"review","duration":128000,"ts":1711700310}
{"type":"workflow_complete","exitReason":"clean","totalDuration":310000,"totalCost":0.45,"ts":1711700310}
```

**This gives:**
- Full timeline reconstruction
- Duration and cost per agent, per phase, per workflow
- Review loop history (how many cycles, what was fixed)
- Exactly where a failure happened (for debugging)

---

## Resumability — Crash Recovery

### Scenario: Pi crashes while builder is running

**State on disk at crash time:**
```
state.json:
  currentPhase: "build"
  activeAgents: [{ agentId: "def456", role: "builder", phase: "build" }]
  completedAgents: [{ agentId: "abc123", role: "scout", handoffFile: "handoffs/01-scout.json" }]

events.jsonl:
  ... scout events ...
  {"type":"agent_start","role":"builder","agentId":"def456","ts":...}
  (no agent_complete — crashed)

handoffs/01-scout.json:
  (scout's full output — intact)
```

**On restart (`session_start` event):**

1. Scan `appendEntry` for `pi-flow:active` → find `workflowDir`
2. Read `state.json` → see `currentPhase: "build"`, active builder agent
3. The builder agent `def456` is dead (pi restarted) — mark it failed in state
4. **Decision point:** Do we auto-resume or ask the user?
   - Check: was the builder the first attempt? → Auto-resume with continuation prompt
   - Check: was this the Nth failure? → Ask user: "Builder failed N times. Continue or abort?"
5. If continuing: read `handoffs/01-scout.json` for context → build continuation prompt → run new builder agent

**The continuation prompt** (adapted from pi-coordination's `buildContinuationPrompt`):
```
## Continuation — Build Phase (Attempt 2)

Previous attempt crashed. Here's what was done:
- Files modified: src/types.ts (partial), src/index.ts (not started)
- Last action: editing src/types.ts line 45

Scout findings (context):
[... summary from handoff ...]

Instructions:
1. Verify src/types.ts changes are valid
2. Continue with remaining work
3. Don't redo completed work
```

### Scenario: User switches session and comes back

Same mechanism — `session_start` fires, we find the active workflow, load state, continue. The handoff files and state.json didn't change.

### Scenario: Session gets compacted

**No impact.** Workflow state is in files (`.pi/flow/`), not in conversation history. Compaction only affects the LLM's conversation context. The orchestrator's tool (`Agent`) will still have access to workflow state because the extension reads it from disk, not from conversation.

---

## Context Efficiency

### Problem: Agents reading the same files repeatedly

**Solution: Handoffs carry the relevant findings, not raw file contents.**

The scout reads 50 files and produces a focused analysis: "These 5 files contain `any` usage, here are the locations." The builder gets THAT, not the 50 files. The builder then reads only the 5 files it needs to modify.

### Problem: Review loop re-reading everything

**Solution: Review handoff carries structured issues, not raw analysis.**

```json
{
  "verdict": "NEEDS_WORK",
  "issues": [
    { "file": "src/types.ts", "line": 45, "description": "any still present in ToolFactory type", "severity": "error" },
    { "file": "src/index.ts", "line": 200, "description": "unused import left from refactor", "severity": "warning" }
  ]
}
```

The fix builder gets exactly what to fix, not "go review the whole codebase again."

### Problem: Orchestrator context grows with each agent

**Solution: Handoff summaries are compact. Full output is on disk.**

The orchestrator LLM sees:
```
Scout completed (45s, 12 tools). Summary: "Found 5 files with `any` usage: src/types.ts (3), src/index.ts (1), src/agents/registry.ts (1)"
```

Not the full 2000-line scout output. If the orchestrator needs more detail, it can read the handoff file.

---

## How This Maps to Each Workflow

### W1: Research (simplest)

```
state.json phases: { probe: "running" }
No handoffs needed — probe reports directly to user
events.jsonl: workflow_start → agent_start → agent_complete → workflow_complete
```

### W2: Explore

```
state.json phases: { explore: "running" }
handoffs/01-explorer.json — explorer's understanding report
events.jsonl: same as W1
```

### W3: Fix

```
state.json phases: { scout: "complete", build: "running", review: "pending" }
handoffs/
  01-scout.json    — findings (what to fix, where)
  02-builder.json  — what was changed
  03-reviewer.json — verdict + issues
  04-builder.json  — fix attempt (if NEEDS_WORK)
  05-reviewer.json — second verdict
events.jsonl: full timeline including approval gate and review cycles
```

### W4: Feature (most complex)

```
state.json phases: { clarify: "complete", plan: "complete", test: "running", build: "pending", review: "pending" }
handoffs/
  01-clarifier.json  — refined spec from user Q&A
  02-planner.json    — structured plan with tasks
  03-test-writer.json — test files written (red)
  04-builder-1.json  — task-1 implementation
  04-builder-2.json  — task-2 implementation (parallel)
  05-reviewer.json   — verdict
tasks/
  plan.json          — task list with dependencies
  task-1.json        — individual task state
  task-2.json        — individual task state
events.jsonl: full timeline including parallel agents, review cycles
```

---

## Summary

| Concern | Mechanism | Why |
|---------|-----------|-----|
| **Recovery bookmark** | `appendEntry("pi-flow:active", { workflowDir })` | Survives session switches, lightweight |
| **Workflow state** | `.pi/flow/<id>/state.json` | Mutable, inspectable, survives compaction |
| **Agent output** | `.pi/flow/<id>/handoffs/<NN>-<role>.json` | Large outputs belong on disk, not in session |
| **Traceability** | `.pi/flow/<id>/events.jsonl` | Append-only timeline, full audit trail |
| **Task state (W4)** | `.pi/flow/<id>/tasks/*.json` | Only for feature workflows with task graphs |
| **Agent comms** | Handoff files → orchestrator reads → builds next prompt | Hub-and-spoke via orchestrator, not direct agent-to-agent |
| **Crash recovery** | `session_start` → scan entries → load state → continue | Proven pattern (pi-planner does exactly this) |
| **Context efficiency** | Handoffs carry summaries + structured data, not raw output | Orchestrator decides what context the next agent needs |
| **Atomic writes** | Temp file + rename | Prevents corrupt state on crash (pi-messenger pattern) |
