# Contributing to pi-flow

This is a solo-maintained project, but contributions are welcome — especially bug reports, skill improvements, and agent prompt refinements.

## What's worth contributing

- **Bug fixes** — something in a skill or agent prompt produces wrong/unhelpful behavior
- **Skill improvements** — clearer instructions, better edge case handling, missing steps
- **Agent prompt refinements** — tighter constraints, better output formats, sharper focus
- **New skills** — well-scoped additions that follow the existing pattern
- **Documentation** — anything that was confusing or missing

## What to do before opening a PR

1. **Open an issue first** for anything beyond a trivial fix — describe what's broken or what you want to add. This avoids wasted effort if the direction isn't right.
2. **Test your changes** by actually running the skill or agent and observing the behavior. These are prompt files — the test is whether the agent does the right thing.
3. **Keep scope tight.** One logical change per PR.

## How skills and agents work

- **Skills** (`skills/<name>/SKILL.md`) — instructions loaded into the main pi session. They guide the orchestrator through a workflow phase. No code, just structured markdown.
- **Agents** (`extensions/subagent/agents/<name>.md`) — system prompts for subagent processes. They define role, constraints, tools, and output format.
- **Search tools** (`skills/exa-search/`, `skills/brave-search/`) — TypeScript CLI scripts used by the `researcher` agent. These have `package.json` dependencies.

## Style conventions

- **Imperative voice** in agent prompts: "Write the failing test. Watch it fail. Then implement."
- **Explicit over implicit** — if a constraint matters, state it directly, not as a hint
- **Short sections with clear headers** — agents read these as context; scannable > prose
- **No placeholder text** — every example should be realistic and specific

## Submitting

Fork → branch → PR against `main`. Describe what changed and why. That's it.
