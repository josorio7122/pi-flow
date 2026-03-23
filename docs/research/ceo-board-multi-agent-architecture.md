# CEO & Board Multi-Agent Architecture — Learnings

Source: [IndyDevDan — The CEO and Board](https://www.youtube.com/watch?v=TqjmTZRL31E)
Date captured: 2026-03-23

---

## Core Concept

A multi-agent system for **strategic decision-making**, not task execution. "Uncertainty in → Decision out."

- CEO agent (Opus 4.6) orchestrates
- Board of specialized agents (Sonnet 4.6) debate adversarially
- Constraint-driven (time + budget limits)
- Produces structured memo + visual artifacts

---

## Project Structure

```
.pi/
├── ceo-agents/
│   ├── agents/              # System prompts per agent (.md with YAML frontmatter)
│   │   ├── ceo.md
│   │   ├── revenue.md
│   │   ├── contrarian.md
│   │   ├── moonshot.md
│   │   └── ...
│   ├── briefs/              # Structured user input (Situation/Stakes/Constraints/Key Question)
│   ├── deliberations/       # conversation.jsonl + tool-use.jsonl + SVGs
│   ├── expertise/           # Persistent scratchpads per agent
│   ├── memos/               # Final output (md + svg + mp3)
│   └── ceo-and-board-configuration.yaml
extensions/
└── ceo-and-board.ts         # ~2000 lines — the orchestration engine (Pi extension)
```

---

## Agent System Prompts

Each agent's `.md` file has YAML frontmatter + structured body:

```yaml
---
name: Revenue
expertise: .pi/ceo-agents/expertise/revenue-scratch-pad.md
updatable: true
skills:
  - skill-generate-SVG
model: anthropic/claude-sonnet-4-6
---
```

### Body Sections

| Section | Purpose |
|---------|---------|
| **Purpose** | Agent's core role and objective |
| **Variables** | Runtime-injected: `{{SESSION_ID}}`, `{{BRIEF_CONTENT}}`, `{{MIN_BUDGET}}`, `{{BOARD_MEMBERS}}` |
| **Instructions** | Step-by-step deliberation procedure |
| **Temperament** | Behavioral traits: "Skeptical but constructive", "Impatient - velocity is a virtue" |
| **Reasoning Patterns** | Named heuristics: "Regret Audit", "Lindy Effect", "Pre-Mortem", "Capital Allocation Lens" |

**Key insight:** Pi extension reads `.md` files, parses frontmatter for config (model, expertise path, skills), injects body as system prompt with variables replaced at runtime.

---

## Tooling

### `converse(to, message)` — Inter-agent communication
- `to`: specific agent name, array of names, or `"all"` (broadcast)
- Appends to `conversation.jsonl` → `{"from": "CEO", "to": "all", "message": "..."}`
- Each agent reads full conversation log before responding

### `condense()` — Context management
- Summarizes long-running state or expertise files
- Handles 1M context window efficiently

### Agent Read/Write Cycle (every turn)
1. **Read** YAML config
2. **Read** current `conversation.jsonl`
3. **Read** personal `scratch-pad.md` (expertise)
4. **Generate** response based on persona + all context
5. **Write** response to deliberation log
6. Optionally **update** scratchpad with new observations

### Output Skills
- `svg-generate` → decision maps, scenario matrices
- `tts-eleven` → ElevenLabs audio summaries

---

## YAML Configuration

```yaml
meeting:
  constraints:
    min_time_minutes: 2
    max_time_minutes: 5
    min_budget: $1
    max_budget: $5
  editor: 'code'
  brief_sections:
    - section: "## Situation"
    - section: "## Stakes"
    - section: "## Constraints"
    - section: "## Key Question"
paths:
  briefs: .pi/ceo-agents/briefs/
  deliberations: .pi/ceo-agents/deliberations/
  memos: .pi/ceo-agents/memos/
  agents: .pi/ceo-agents/agents/
board:
  - name: Revenue
    path: .pi/ceo-agents/agents/revenue.md
    color: "#ff4d4d"
  - name: Product Strategist
    path: .pi/ceo-agents/agents/product-strategist.md
    color: "#feda00"
  - name: Technical Architect
    color: ...
  - name: Contrarian
    color: ...
  - name: Compounder
    color: ...
  - name: Moonshot
    color: ...
```

---

## Deliberation Engine (Orchestration Loop)

```
User runs: just ceo → triggers /ceo-begin

1. BRIEF SELECTION
   └─ TUI presents list of briefs from briefs/ directory
   └─ User selects one

2. CEO FRAMING
   └─ CEO (Opus 4.6) reads: brief + own scratchpad + config
   └─ CEO calls: converse(to: "all", message: "Here's what we're deciding...")

3. BOARD DEBATES (parallel, multiple rounds)
   └─ All board agents respond IN PARALLEL (not sequential)
   └─ Each reads: conversation.jsonl + own scratchpad + expertise
   └─ Each writes: position statement back to conversation log
   └─ CEO reads all responses, identifies "unresolved tensions"
   └─ CEO calls converse() again to push deeper

4. CONSTRAINT CHECK (after each round)
   └─ Extension checks elapsed_time vs max_time_minutes
   └─ Extension checks accumulated_cost vs max_budget
   └─ If exceeded → "Max Reached" flag

5. FINAL STATEMENTS
   └─ CEO sends end_deliberation to all agents
   └─ Each agent gives 1-2 sentence final position

6. MEMO GENERATION
   └─ CEO synthesizes into memo.md
   └─ CEO uses svg-generate → decision-map.svg
   └─ CEO uses tts-eleven → audio-summary.mp3
```

---

## Board Roles

| Agent | Focus | Tension With |
|-------|-------|-------------|
| **Revenue** | 90-day cash, short-term ROI | Moonshot |
| **Product Strategist** | User retention, platform utility | Revenue |
| **Technical Architect** | Feasibility, production systems | Moonshot |
| **Contrarian** | Hidden risks, blind spots, flawed assumptions | Everyone |
| **Compounder** | Long-term compounding growth | Revenue |
| **Moonshot** | 10X category-defining bets | Revenue, Tech Architect |

---

## Expertise/Scratchpad Files (Persistent Memory)

- Survive across sessions — agent's evolving memory
- Track **recurring patterns** noticed across deliberations
- Record **stance shifts** and reasoning
- Note **fault lines** — areas of consistent disagreement
- Build **domain models** — agent's understanding of the business
- `updatable: true` in frontmatter controls write access

---

## Output Artifacts

| Output | How Generated |
|--------|--------------|
| `memo.md` | CEO synthesizes — ranked recommendations, stances, tensions, trade-offs, next actions |
| `decision-map.svg` | Agent writes raw SVG via `svg-generate` skill |
| `audio-summary.mp3` | ElevenLabs API via `tts-eleven` skill |
| `conversation.jsonl` | Auto-logged by `converse()` tool |
| `tool-use.jsonl` | Auto-logged — every tool call with timing |

---

## Key Engineering Principles

1. **Specialization > Generalization** — generic agents produce "normal distribution" results; custom personas with temperaments and reasoning patterns differentiate
2. **Adversarial tension** — always include a Contrarian to stress-test consensus
3. **Constraint-driven** — time + budget limits prevent runaway costs and force decisions
4. **Persistent state** — scratchpads that survive across sessions make agents increasingly valuable
5. **Structured I/O** — enforce Brief templates on input, Memo format on output
6. **Observability** — log everything (conversation, tool use, time, cost) — "if you don't measure it, you cannot improve it"
7. **Parallel execution** — board members respond simultaneously, not sequentially
8. **The extension IS the state machine** — Pi extension manages transitions (continue debating vs. wrap up), the CEO agent is the decision point

---

## How to Build This

1. **Pi extension** that registers `converse()` as custom tool — appends to JSONL, broadcasts to agents
2. **Agent spawning** — read YAML config, parse each board member's `.md` frontmatter, inject runtime variables, spawn with their model
3. **Parallel execution** — board members respond simultaneously
4. **Constraint loop** — after each round, check time + cost, continue or force final statements
5. **Persistent state** — read/write scratchpad files across sessions
6. **Structured I/O** — Brief templates in, Memo format out

---

## Quotes Worth Remembering

> "Uncertainty in, decision out."

> "If you don't measure it, you cannot improve it. Full stop."

> "The irreplaceable engineers of tomorrow aren't typing code. They're commanding compute."

> "If you don't specialize them, you're getting the normal distribution of what everyone else is building."
