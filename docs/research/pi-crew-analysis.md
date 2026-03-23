# pi-crew — My Agentic Dev Workflow (Self-Analysis)

Source: `/Users/josorio/Code/pi-packages/packages/pi-crew/`
Date captured: 2026-03-23

---

## What It Is

A Pi extension that transforms Pi into an **agentic coding coordinator**. Instead of doing everything yourself, you dispatch specialized agents through structured workflows. The coordinator (you + Pi) never writes code directly — it delegates to scouts, researchers, architects, executors, reviewers, and debuggers.

- **~7K lines** (code + tests)
- **v1.0.0**, mature, no tech debt
- **18 test files, ~3,240 lines** of tests
- **6 agent presets**, 3 dispatch modes, 6 workflow phases

---

## Architecture

```
You (human)
  ↓ natural language
Pi (coordinator) — NEVER writes code directly
  ↓ dispatch_crew tool
  ├── Scout (haiku) — read-only codebase exploration
  ├── Researcher (haiku) — web/docs research via exa-search
  ├── Architect (sonnet) — design decisions, specs
  ├── Executor (sonnet) — implements tasks, follows TDD
  ├── Reviewer (sonnet) — code review, spec compliance
  └── Debugger (sonnet) — root cause analysis, surgical fixes
```

### .crew/ Workspace

```
.crew/
├── config.json           # Profile + per-agent model overrides
├── state.md              # Active workflow (YAML frontmatter + progress log)
├── dispatches/           # Audit trail — every dispatch logged
├── findings/             # Reusable research output
└── phases/<feature>/     # Workflow handoffs
    ├── explore.md
    ├── design.md
    ├── build.md
    └── review.md
```

---

## Three Modes

### 1. Just Answer
Non-codebase questions → answer directly. No dispatch needed.

### 2. Understand (Research)
Codebase questions → dispatch scouts/researchers → synthesize → write to `.crew/findings/`.

### 3. Implement (Full Workflow)
Code changes → 6-phase workflow:
```
explore → design → plan → build → review → ship
```

---

## Six Agent Presets

| Preset | Model Tier | Tools | Purpose |
|--------|-----------|-------|---------|
| **scout** | budget (haiku) | read, bash, grep, find, ls | Fast codebase exploration, read-only |
| **researcher** | budget (haiku) | read, bash | Web/docs research via exa-search |
| **architect** | quality (sonnet/opus) | read, bash, grep, find, ls | Design decisions, specs, trade-offs |
| **executor** | balanced (sonnet) | read, write, edit, bash, grep, find, ls | Implements tasks, TDD, commits per task |
| **reviewer** | balanced (sonnet) | read, bash, grep, find, ls | Code review, spec compliance, security |
| **debugger** | quality (sonnet/opus) | read, write, edit, bash, grep, find, ls | Root cause analysis, surgical repair |

### Model Profiles (3 profiles × 3 tiers)

| Profile | Budget Tier | Balanced Tier | Quality Tier |
|---------|------------|---------------|--------------|
| **quality** | sonnet | sonnet | opus |
| **balanced** | haiku | sonnet | sonnet |
| **budget** | haiku | haiku | sonnet |

Per-agent overrides via `.crew/config.json` or `/crew:override`.

---

## Three Dispatch Modes

### Single
```
dispatch_crew({ preset: "scout", task: "Map the auth module" })
```

### Parallel (2-5 agents, max 8)
```
dispatch_crew({ tasks: [
  { preset: "scout", task: "Map frontend" },
  { preset: "scout", task: "Map backend" }
]})
```

### Chain (sequential, {previous} placeholder)
```
dispatch_crew({ chain: [
  { preset: "scout", task: "Find all API endpoints" },
  { preset: "architect", task: "Design solution based on: {previous}" }
]})
```

---

## Six Workflow Phases

| Phase | Allowed Presets | Auto-Advance | Purpose |
|-------|----------------|:---:|---------|
| **explore** | scout, researcher | ✅ | Map relevant code, write findings |
| **design** | architect, researcher, scout | ✅ | Present options, lock decisions |
| **plan** | scout, researcher | ✅ | Break design into executor-ready tasks |
| **build** | executor, debugger, scout | ❌ | Implement wave by wave, debug failures |
| **review** | reviewer, scout | ❌ | Spec compliance, quality, security |
| **ship** | scout, researcher | ✅ | Push branch, open PR/MR |

---

## Mechanical Enforcement (Not Advisory)

### 1. Tool Blocking
The coordinator can only write/edit inside `.crew/`. All code changes must go through dispatched agents.

```typescript
// tool_call hook — hard block, not a suggestion
if (toolName === "write" || toolName === "edit") {
  if (!isCrewPath(path)) return { block: true, reason: "..." };
}
```

### 2. Phase Gates
Can't advance to next phase without prior phase's handoff file existing.

```
build phase requires: .crew/phases/<feature>/design.md exists
review phase requires: .crew/phases/<feature>/build.md exists
```

### 3. Preset Validation
Can't dispatch wrong agent type for current phase.

```
explore phase → only scout, researcher allowed
build phase → only executor, debugger, scout allowed
```

All enforcement is **pure functions returning error messages**, never throwing.

---

## Subprocess Spawning

### How Agents Are Spawned
```bash
pi --mode json -p --no-session --no-extensions \
  --model <model> --tools <tools> --thinking <level> \
  --append-system-prompt <temp-file> \
  "<task>"
```

Each agent is an independent Pi subprocess with:
- Its own model (resolved from profile + tier)
- Its own tool set (from preset definition)
- Its own system prompt (from `references/prompts/<preset>.md`)
- NDJSON output parsed in real-time

### Concurrency Management
- **Default**: 4 parallel agents
- **Max**: 8 agents
- **Staggered starts**: 150ms between spawns (avoids lock file contention)
- **Retry**: Exponential backoff on transient errors (lock file held, API key not found)
- **Max retries**: 3 per agent

---

## System Prompts (What Each Agent Knows)

### Scout
- Read-only codebase exploration
- Output: `## Findings: {topic}` with Structure, Key Files, Patterns, Concerns
- Rules: be thorough, be concise, include file paths & line counts

### Researcher
- Web/docs research via exa-search skill
- Protocol: clarify → search broadly → fetch key pages → cross-reference → synthesize
- Output: structured findings with Answer, Key Findings, Sources

### Architect
- Design decisions, trade-off analysis, spec writing
- Multiple options presented, grounded in codebase
- Output: Goal, Constraints, Approaches, Trade-offs, Specification

### Executor
- TDD: RED (failing test) → GREEN (pass) → commit
- Deviation rules: auto-fix bugs/blockers; STOP for architecture changes
- Analysis paralysis guard: 5+ read/grep without write → STOP or write
- Commits per logical unit of work

### Reviewer
- Code review for spec compliance, quality, security
- Read-only — never modifies code
- Checks: naming, error handling, test coverage, security, performance

### Debugger
- Root cause analysis, surgical repair
- Reads failing test, traces to fix
- Minimal changes, regression test required

---

## Rendering (Real-Time Agent Cards)

```
┌─ scout #1 ──────────────────────────────────┐
│ Task: Map the authentication module          │
│ Status: running (12.3s)                      │
│ > read(src/auth/index.ts)                    │
│ > grep(pattern: "middleware", path: "src/")  │
└──────────────────────────────────────────────┘
```

- DynamicBorder cards with preset name, instance number, task
- Real-time tool call streaming
- Final output: usage stats (turns, tokens, cost, model)

---

## Commands

| Command | Action |
|---------|--------|
| `/crew` | Show current status (feature, phase, profile) |
| `/crew:profile <name>` | Switch model profile (quality/balanced/budget) |
| `/crew:override <preset> <model>` | Override specific agent's model |
| `/crew:reset` | Clear workflow state |
| `/crew:status` | Detailed status of current feature |

---

## Module Breakdown

| File | Lines | Responsibility |
|------|-------|---------------|
| `index.ts` | 858 | Tool registration, dispatch logic, commands, hooks |
| `rendering.ts` | 448 | Agent cards, tool call formatting, usage stats |
| `spawn.ts` | 333 | Subprocess spawning, NDJSON parsing, concurrency |
| `state.ts` | 228 | .crew/ state management, YAML frontmatter |
| `handoff.ts` | 139 | Handoff/dispatch/findings file I/O |
| `presets.ts` | 123 | Agent preset definitions |
| `phases.ts` | 119 | Phase metadata, allowed presets |
| `prompt.ts` | 98 | Coordinator system prompt builder |
| `tool-blocking.ts` | 98 | Write/edit blocking outside .crew/ |
| `enforcement.ts` | 91 | Phase gates, preset validation |
| `profiles.ts` | 68 | Model profile resolution |

---

## Strengths

1. **Mechanical enforcement** — tool blocking, phase gates, preset validation are code-enforced, not suggestions
2. **Clean separation** — coordinator never writes code; all changes through agents
3. **Audit trail** — every dispatch logged to `.crew/dispatches/`, handoffs to `.crew/phases/`
4. **Model flexibility** — 3 profiles × 3 tiers + per-agent overrides
5. **Resilient spawning** — lock retry, staggered starts, exponential backoff
6. **Real-time rendering** — inline agent cards with tool call streaming
7. **No tech debt** — zero TODO/FIXME/HACK markers, comprehensive tests

## Weaknesses / Opportunities

1. **Always loaded globally** — unlike Dan's `-e` pattern, pi-crew is always in context even when not needed. Could be loaded on-demand via justfile.
2. **No session continuity** — unlike context-mode, dispatches don't persist across sessions. If Pi compacts, .crew/ state survives but agent outputs don't resume.
3. **No context window management** — agents can flood their own context with large file reads or command output. No sandbox/index/search pattern like context-mode.
4. **Single orchestrator model** — coordinator is always the session's main model. Can't cheaply use haiku for coordination and opus for execution simultaneously (agents are separate subprocesses, but coordinator prompt uses the session model).
5. **No adversarial patterns** — unlike CEO & Board, there's no built-in tension between agents. Reviewer is the closest, but it reviews after the fact, not during.
6. **No persistent memory** — agents don't have scratchpads or expertise files. Each dispatch starts fresh. No learning across sessions.
7. **Phase workflow is rigid** — always 6 phases. No way to skip or customize the workflow (e.g., just explore+build for small fixes).
8. **index.ts is 858 lines** — largest file, handles too many concerns (dispatch logic + commands + hooks + rendering). Could be split.

## Compared to Other Systems

| Aspect | pi-crew | gstack | CEO & Board | context-mode |
|--------|---------|--------|-------------|-------------|
| **Focus** | Workflow orchestration | 28 specialist roles | Strategic decisions | Context window mgmt |
| **Agents** | 6 presets via subprocess | Single agent, role switching | 7 agents (CEO + board) | N/A (MCP tools) |
| **Enforcement** | Mechanical (code) | Instructions (SKILL.md) | Extension controls flow | Hooks + instructions |
| **Memory** | None (stateless agents) | None | Persistent scratchpads | Session events + snapshots |
| **Context mgmt** | None | None | 1M context models | FTS5 sandbox + search |
| **Platforms** | Pi only | Claude Code primary | Pi only | 12 platforms |
| **Customizable** | Profiles + overrides | Fork skills | YAML config | Adapter system |
