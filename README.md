# pi-flow

A state-of-the-art agentic software development workflow for [pi](https://github.com/mariozechner/pi-coding-agent).

pi-flow replaces pi-crew with a spec-driven, adversarially-reviewed, memory-augmented orchestration system. It turns the pi coordinator into a software development orchestrator with 7 adaptive phases, 8 specialized sub-agents, and persistent cross-session memory.

## Status

**Active development** — core execution engine implemented with in-process agent sessions via pi's `createAgentSession()` SDK.

## Architecture

The complete architecture is documented in [`docs/architecture.md`](docs/architecture.md) (7,200+ lines, 14 sections).

### Workflow

```
INTENT → SPEC → ANALYZE → PLAN → EXECUTE → REVIEW → SHIP
```

Each phase has entry conditions, specialized agents, checkpointing, and exit gates. The workflow is adaptive — hotfixes skip SPEC and PLAN, docs-only changes skip ANALYZE and REVIEW.

### Agents

8 specialized agents defined as `.md` files with YAML frontmatter:

| Agent | Model | Role |
|-------|-------|------|
| **Clarifier** | opus | Extract EARS-structured spec from user intent |
| **Scout** | sonnet | Codebase analysis and pattern mapping |
| **Strategist** | opus | Architecture decisions with trade-offs |
| **Planner** | sonnet | Break design into executable waves |
| **Builder** | sonnet | TDD implementation (red → green → commit) |
| **Sentinel** | opus | Adversarial review after each build wave |
| **Reviewer** | opus | Full spec compliance verification |
| **Shipper** | sonnet | Git, docs, PR/MR, cleanup |

### Key Innovations

- **Spec-first** — EARS-notation behaviors before any code analysis
- **Per-wave adversarial review** — Sentinel reviews after each build wave, not just at the end
- **Adaptive workflow** — 5 skip paths based on change type
- **Frontmatter-defined agents** — extend by dropping a `.md` file
- **File-based persistent memory** — decisions, patterns, and lessons across features
- **Sub-agent isolation** — `--no-extensions` prevents sub-agents from spawning other agents

### Research

The design draws from 7 research documents analyzing pi-crew, agentic coding best practices (2026), context-mode, CEO & Board deliberation, gstack workflows, and LanceDB.

See [`docs/research/`](docs/research/) for the complete research corpus.

## License

MIT
