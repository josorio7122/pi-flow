# Agentic Coding Best Practices (2026)

Date captured: 2026-03-23
Sources: Multiple research papers, blog posts, and production systems (2025-2026)

---

## Multi-Agent Orchestration Patterns

### The 4 Proven Patterns

| Pattern | How It Works | Best For | Example |
|---------|-------------|----------|---------|
| **Orchestrator-Worker** | Central coordinator delegates to isolated workers (git worktrees/Docker). Never executes itself. FIFO merge order. | Parallel coding tasks, complex features | Devin, Conductor, Codex parallel |
| **Pipeline** | Sequential agents: research → draft → review | Content creation, spec-driven dev | gstack autoplan, GitHub Spec Kit |
| **Router** | Classifier directs tasks to specialist agents | Multi-domain support, varied task types | Customer service bots |
| **Evaluator-Optimizer** | Agent generates → evaluator scores → iterate | Code quality, test generation | Design review loops |

### Orchestrator-Worker (State of the Art)

Key rules from production:
1. **Orchestrator NEVER writes code** — only delegates and merges
2. **Workers get isolated git worktrees** — own checkout, own node_modules, own index
3. **30% implicit scope threshold** — if agent expands scope beyond 30%, investigate, don't allow
4. **FIFO merge order** — deterministic sequential merging prevents conflicts
5. **Five-signal failure detection:** heartbeat (20s poll), content hashing, transport errors, tool-call awareness, **git activity watchdog** (only proven method to catch "productive-looking stuck loops")

---

## Agent Harness Engineering

> "Harness engineering is the 90% that matters. System prompt + tools + memory + safeguards + model routing determine output quality more than which LLM."

### Four Customization Levers

1. **System prompt** — instruction discipline ("CRITICAL: always do X")
2. **Tools/MCPs** — capability scope (MCP for enterprise, CLI for dev)
3. **Sub-agents** — context firewall (discrete tasks in isolated windows prevent noise)
4. **Hooks + Skills** — automated control flow and progressive disclosure

### Minimal Viable Harness

Start with 4 core tools: `read`, `write`, `edit`, `bash` + 200-token system prompt. Add only what's needed.

---

## Tool Strategy: MCP vs CLI vs Custom

| Aspect | CLI Tools | MCP Servers | Custom Tools |
|--------|----------|-------------|-------------|
| Token cost | ~200 tokens/command | ~33K-55K overhead + per-call | Varies |
| Token efficiency score | 202.1 | 152.3 | N/A |
| Governance | None | OAuth, audit, multitenancy | Manual |
| LLM familiarity | Native (trained on billions of examples) | Requires schema learning | Requires docs |
| Best for | Dev/coding agents | Enterprise, regulated industries | Unique logic |

**Decision tree:**
- Default: CLI tools (git, npm, curl) for coding agents
- Wrap critical tools as MCP for enterprise/multi-tenant
- Custom tools only when no CLI/MCP equivalent exists
- **~30 tools is practical max** — beyond requires filtering

---

## Context Engineering

### Definition

> "The delicate art and science of filling the context window with just the right information for the next step." — Andrej Karpathy

Context engineering > prompt engineering. It's about managing ALL information sources, not just crafting better instructions.

### The Four Buckets

| Technique | What | Token Impact |
|-----------|------|-------------|
| **Write** | Save info outside context (scratchpads, memory files) | ↓ reduces per-turn context |
| **Select** | Retrieve only relevant pieces (RAG, semantic search) | ↓ 50-70% reduction vs full load |
| **Compress** | Summarize before injection | ↓ 80-90% reduction |
| **Isolate** | Segment by relevance; load only what's needed now | ↓ prevents tool bloat |

### Token Budget Template (Coding Agents)

| Category | Tokens | % |
|----------|--------|---|
| System prompt | 1,500-3,000 | 15-30% |
| Tool definitions | 1,000-3,000 | 10-20% |
| Retrieved docs (RAG) | 2,000-5,000 | 20-50% |
| Conversation history | 1,000-2,000 | 10-20% |
| Agent state | 200-500 | 2-5% |
| Padding | 500-1,000 | 5-10% |
| **Total typical** | **6,000-14,000** | **100%** |

### Context Failure Modes

- **Context poisoning** — hallucinations enter stored context
- **Context distraction** — quantity obscures signal
- **Context confusion** — superfluous info changes behavior
- **Context clash** — conflicting information
- **Context rot** — GPT-4o accuracy drops from 98.1% → 64.1% based on presentation alone

### Long Context vs RAG vs Summarization

| Approach | Best For | Weakness |
|----------|---------|----------|
| **Long context** (1M tokens) | Holistic reasoning, full docs | Expensive, attention degradation |
| **RAG** | Precise lookup, large corpora | Fragments knowledge, retrieval quality |
| **Summarization** | Session continuity, history compression | Detail loss, stale info |
| **Hybrid** (consensus) | Most production use | Engineering complexity |

**2026 consensus:** Long context for episodic tasks + RAG for precise lookup + summarization for temporal compression.

---

## Spec-Driven Development (SDD)

### Why Specs First for AI

When you tell an LLM "add health endpoints," it makes dozens of implicit decisions. SDD makes those explicit upfront.

> METR study (Feb 2026): Developers using unstructured AI prompts were **19% slower** despite reporting higher confidence.

### The 4-Phase Pipeline

```
Specify  →  Plan  →  Tasks  →  Implement
```

1. **Specify** → `requirements.md` (WHAT + WHY)
2. **Plan** → `design.md` (HOW — architecture, data flow, diagrams)
3. **Tasks** → `tasks.md` (ordered, executable, with dependencies)
4. **Implement** → TDD: test (red) → code (green) → commit

**Gate rule:** Do NOT proceed without explicit user approval between phases.

### Three-Document Structure (Industry Consensus)

| Document | Purpose | Contains |
|----------|---------|----------|
| `requirements.md` | WHAT + WHY | User stories, acceptance criteria, EARS notation |
| `design.md` | HOW | Architecture, sequence diagrams, data flows, dependencies |
| `tasks.md` | TASKS | 5-15 ordered tasks per feature, each completable in one agent session |

### Spec Format: SPEC.md Template

```markdown
# Feature: [Name]

## Goal
What must be true when complete (observable outcome).

## Behaviors
Observable system outcomes (no implementation details).

## Contracts
Data shapes at system boundaries (TypeScript interfaces, request/response).

## Constraints
Existing system properties to preserve (invariants, architectural rules).

## Error Cases
How system behaves under failure.

## Out of Scope
What this work explicitly does NOT do.

## Open Questions
Unresolved decisions blocking the spec.
```

### EARS Notation (Industrial Standard)

```
WHEN [trigger] THE [component] SHALL [behavior]
```

Machine-parseable. Supports auto-generated tests. Used by Kiro, Rolls-Royce.

### Tools for SDD

| Tool | Approach | Best For |
|------|----------|---------|
| **GitHub Spec Kit** | Static markdown specs, 4-phase workflow, MIT | Open-source, cross-agent (71K stars) |
| **Kiro (AWS)** | EARS notation, auto-test generation | AWS-native greenfield |
| **Intent (Augment)** | Living specs, multi-agent, bidirectional sync | Complex multi-service codebases |
| **Cursor Plan Mode** | Interactive planning, .cursor/plans/ | Quick exploration |
| **pi write-spec** | 4-phase gated workflow | Pi agent users |

### Spec Maintenance

| Approach | How | Trade-off |
|----------|-----|-----------|
| **Living specs** (Intent) | Specs update atomically as agents work | Complex infrastructure |
| **Specs as code** | Specs in repo, PR review, git blame | Manual updates required |
| **AI-generated** | Reverse-engineer specs from existing code | Quality varies |
| **Progressive context** | 1-page summary always current; details on-demand | May miss connections |

---

## AGENTS.md / CLAUDE.md Patterns

### Universal Standard (2026)

AGENTS.md works across Claude Code, Cursor, Codex CLI, Gemini CLI, Windsurf.

### Optimal Structure

```markdown
# AGENTS.md

## Project Overview
(2-3 sentences: what, tech stack, deployment)

## Architecture
- Directory organization and module responsibilities
- Key integration points

## Commands
- Install: `pnpm install`
- Dev: `pnpm dev`
- Test: `pnpm test`
- Lint: `pnpm lint:fix`

## Coding Standards
- Specific rules with code examples (5 lines beat 50 of prose)
- 3-5 standards max
- Show patterns from YOUR codebase

## What to Avoid
- Explicit constraints (what NOT to do)
- Common mistakes this codebase has made
```

### Rules for Config Files

- ✅ Under 300 lines (use @imports for detail)
- ✅ Specific: "Use snake_case for DB columns"
- ✅ Code examples from your actual codebase
- ❌ Vague: "Write clean code"
- ❌ Over 1000 tokens
- ❌ Stale info (worse than no config)

### Hierarchy (Claude Code)

```
Enterprise policies → Personal (~/.claude/) → Project (./CLAUDE.md) → Subdirectory (./src/CLAUDE.md)
```

---

## Memory & Persistence

### Three-Layer Architecture

| Layer | Storage | Persistence | Best For |
|-------|---------|-------------|---------|
| **Working memory** | Context window | This turn only | Current task, immediate reasoning |
| **Session memory** | Scratchpads, state files | This session | Multi-turn progress, intermediate results |
| **Long-term memory** | Files, vector DB, graph DB | Cross-session | Learned patterns, domain knowledge |

### Scratchpad Pattern

Agent writes notes to itself mid-task:
- Prevents info loss when context fills
- Stored in filesystem or runtime state
- Anthropic recommends: persist plan to memory before context exceeds 200K tokens

### Memory Write Discipline

- Filter low-signal records
- Canonicalize dates/names
- Deduplicate
- Priority-score by novelty
- Tag metadata (timestamp, source, task, confidence)

---

## Guardrails & Safety

### SAFE Framework (2026)

| Principle | What | How to Measure |
|-----------|------|---------------|
| **Scope** | Define authority boundaries | Task adherence rate; detect silent scope creep |
| **Anchored Decisions** | Actions grounded in evidence | Degrade autonomy under uncertainty |
| **Flow Integrity** | Trajectory stays controlled | Monitor tool efficiency, parameter accuracy |
| **Escalation** | Clear stop conditions | High-impact + failed validation → stop |

### Concrete Guardrails

- **Budget caps:** Token limits per task, cost caps per agent
- **Step limits:** Hard 50-step max
- **Loop detection:** Same action repeated → circuit breaker
- **Time-based:** Hard timeout after N minutes
- **Git activity watchdog:** Only proven method to catch "productive-looking stuck loops"
- **Human-in-the-loop:** Approval gates for destructive/high-risk actions

---

## Observability

### What to Track

| Metric | Why |
|--------|-----|
| Step count | Iterations to solve |
| Tool success rate | Are tools working? |
| Loop detection | Same action repeated |
| File I/O | What agent read/wrote/deleted |
| Escalation frequency | How often agent gives up |
| Scope adherence | Staying within boundaries |
| Token usage per step | Cost tracking |
| First-response latency | Rate limit detection |
| Inter-turn peak latency | Slowness detection |

### Tools (2026)

| Tool | Type | Best For |
|------|------|---------|
| **LangSmith** | Deep tracing | Thought process replay, dataset generation |
| **Langfuse** | Open-source | Self-hostable, model-agnostic |
| **AgentTrace** | Structured logging | Deterministic replay, fork-and-fix |
| **Braintrust** | Eval-first | Integrated evals in dev + production |

---

## Progressive Disclosure (Skill Loading)

### Three Tiers

| Tier | When | Tokens | What |
|------|------|--------|------|
| **Discovery** | Always on | ~80/skill | Name + description only |
| **Activation** | When relevant | 275-8,000 | Full instructions |
| **Execution** | During task | On-demand | Scripts, references |

Example: 17 skills at discovery = ~1,700 tokens. Activating 2 = +4,300 tokens. vs loading all = 8,000+ tokens.

---

## Production Checklist

- [ ] Each agent runs in isolated git worktree or Docker
- [ ] Token cap per task, cost cap per agent
- [ ] Implicit scope ratio measured; halt if >30%
- [ ] 50-step max, time-based circuit breaker, loop detector
- [ ] Escalation triggers defined (failed validation, unresolved uncertainty, repetitive behavior)
- [ ] Tracing enabled (LangSmith/Langfuse), artifact logging
- [ ] HITL gates for high-risk actions
- [ ] Clean baseline between evaluations
- [ ] AGENTS.md < 300 lines, tested (new session → agent explains project correctly)
- [ ] Specs written before code (4-phase pipeline)
- [ ] Token budget established and monitored

---

## Brief Templates

### Situation / Stakes / Constraints / Key Question

```markdown
## Situation
Current state. What exists. What's broken or missing.

## Stakes
Why this matters. Business impact. User impact.

## Constraints
What can't change. Budget. Timeline. Infrastructure limits.

## Key Question
The core thing we're trying to resolve.
```

### User Story → Acceptance Criteria

```markdown
## User Story
As a [user type], I want [capability], so that [benefit]

## Acceptance Criteria
- WHEN [scenario] THEN [observable outcome]
- WHEN [scenario] THEN [observable outcome]
```

---

## Key Quotes

> "Harness engineering is configuration, not models." — HumanLayer

> "The delicate art and science of filling the context window with just the right information for the next step." — Andrej Karpathy

> "METR study: Developers using unstructured AI prompts were 19% slower despite reporting higher confidence."

> "Context engineering is now the #1 job of engineers building AI agents — more important than which model you use." — Consensus across Anthropic, Cognition, Manus, Cloudflare

---

## Sources

### Multi-Agent & Harness
- [Why Your AI Orchestrator Should Never Write Code (Mar 2026)](https://building.theatlantic.com/why-your-ai-orchestrator-should-never-write-code-a1b5d1a2807d)
- [Skill Issue: Harness Engineering (Mar 2026)](https://humanlayer.dev/blog/skill-issue-harness-engineering-for-coding-agents)
- [CLI-Based Agents vs MCP (Mar 2026)](https://lalatenduswain.medium.com/cli-based-agents-vs-mcp-the-2026-showdown-that-every-ai-engineer-needs-to-understand-7dfbc9e3e1f9)
- [SAFE Framework (Mar 2026)](https://pub.towardsai.net/safe-designing-responsible-agentic-systems-3dcc27075d4b)
- [Agent Memory Survey (Feb 2026)](https://arxiv.org/html/2602.10133)
- [Best AI Agent Observability Tools (Feb 2026)](https://www.braintrust.dev/articles/best-ai-agent-observability-tools-2026)

### Spec-Driven Development
- [GitHub Spec Kit (Feb 2026)](https://github.com/github/spec-kit) — 71K stars, MIT
- [Augment Code: SDD Explained (Sep 2025)](https://www.augmentcode.com/guides/spec-driven-development-ai-agents-explained)
- [Dave Patten: SDD with AI Agents (Jan 2026)](https://medium.com/@dave-patten/spec-driven-development-with-ai-agents-from-build-to-runtime-diagnostics-415025fb1d62)
- [METR Developer Productivity (Feb 2026)](https://metr.org/blog/2026-02-24-uplift-update/)
- [Markdown API (MAPI)](https://markdownapi.org)

### Context Engineering
- [LangChain: Context Engineering for Agents (Jul 2025)](https://blog.langchain.com/context-engineering-for-agents)
- [Galileo: Deep Dive (Sep 2025)](https://galileo.ai/blog/context-engineering-for-agents)
- [State of Context Engineering 2026 (Mar 2026)](https://medium.com/@kushalbanda/state-of-context-engineering-in-2026-cf92d010eab1)
- [Complete Guide to CLAUDE.md & AGENTS.md (Feb 2026)](https://medium.com/data-science-collective/the-complete-guide-to-ai-agent-memory-files-claude-md-agents-md-and-beyond-49ea0df5c5a9)
- [Token Compression Techniques (Mar 2026)](https://www.sitepoint.com/optimizing-token-usage-context-compression-techniques/)
- [How I Reduced LLM Token Costs by 90% (Mar 2026)](https://medium.com/@ravityuval/how-i-reduced-llm-token-costs-by-90-using-prompt-rag-and-ai-agent-optimization-f64bd1b56d9f)
- [Cursor: Best Practices for Agents (Jan 2026)](https://cursor.com/blog/agent-best-practices)
