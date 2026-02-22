---
name: research
description: Structured research phase for greenfield projects or unfamiliar tech. Dispatches researcher agents in parallel to cover stack options, best practices, CLI scaffolding, and current documentation. Use before brainstorming a new project or when adopting an unfamiliar technology. Produces a Research Brief.
---

# Research

Gather current, accurate information before making any technology or design decisions.

**Announce at start:** "I'm using the research skill to gather current information before we design."

## When to Use

- Starting a new project from scratch (before brainstorming)
- Adopting a technology or framework you haven't used recently
- Comparing stack options before committing
- Checking whether best practices have changed for a known stack
- Any time "I'm not sure what the current best practice is"

## Process

### Step 1: Define research questions

Before dispatching, identify what you need to know. Common research areas:

| Area | Question type |
|---|---|
| Stack options | "What are the best frameworks for X in 2025?" |
| CLI scaffolding | "What is the current CLI command to scaffold Y?" |
| Best practices | "What is the recommended way to do Z in framework V?" |
| Docs lookup | "What is the config format for tool T v3?" |
| Ecosystem | "What packages/tools are standard in this stack?" |

### Step 2: Dispatch researcher agents in parallel

Group questions by independent topic — each researcher gets one focused question:

```
subagent(tasks: [
  {
    agent: "researcher",
    task: "<focused research question 1>"
  },
  {
    agent: "researcher",
    task: "<focused research question 2>"
  },
  {
    agent: "researcher",
    task: "<focused research question 3>"
  }
])
```

Maximum 4-5 parallel researchers. Each gets one clear question.

### Step 3: Synthesize into Research Brief

```markdown
# Research Brief: [Topic/Project]

## Context
What we're building / deciding.

## Findings

### [Topic 1]
[Key findings, recommendation, source]

### [Topic 2]
[Key findings, recommendation, source]

## Recommended Stack / Approach
| Concern | Recommendation | Rationale |
|---|---|---|
| [e.g., Framework] | [e.g., Next.js 15] | [why] |
| [e.g., Styling] | [e.g., Tailwind v4] | [why] |

## CLI Setup Commands
```bash
# Exact commands to scaffold this project
pnpm dlx create-next-app@latest my-app --typescript --tailwind
```

## Key Docs to Reference
- [Official docs URL] — what's there
- [Migration guide URL] — if upgrading

## Risks / Watch Out For
- [Anything that looked like a footgun or common mistake]
```

### Step 4: Present and confirm

Present the Research Brief. Ask: "Does this match what you had in mind? Any concerns before we start designing?"

Once confirmed, invoke `brainstorming` skill.

## Integration

**Called before:** `brainstorming` (for new projects or unfamiliar tech)
**Uses:** `researcher` agents in parallel
**Produces:** Research Brief that feeds brainstorming
**Does NOT replace:** `brainstorming` — research informs design, it doesn't replace it
