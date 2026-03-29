# pi-flow

A pi extension that brings smart autonomous sub-agents to pi. Agents run in their own context window with custom system prompts, tools, and optional git worktree isolation.

## Tools

| Tool | Description |
|------|-------------|
| `Agent` | Spawn a sub-agent (foreground or background) |
| `get_subagent_result` | Check status or retrieve results from a background agent |
| `steer_subagent` | Send a steering message to a running agent |

## Commands

| Command | Description |
|---------|-------------|
| `/agents` | Interactive menu — manage agent types, view running agents, settings |

## Project Structure

```
src/
├── agents/       # Agent lifecycle — manager, runner, registry, defaults
├── config/       # Input resolution — model, prompt, skills, invocation
├── infra/        # OS/git/filesystem — memory, worktree, env, context
├── extension/    # pi wiring — command, rpc, group-join, helpers
├── ui/           # TUI — widget, viewer, formatters
├── index.ts      # Extension entry point
└── types.ts      # Shared types
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
