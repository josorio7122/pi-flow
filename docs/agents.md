# Agent Configuration Guide

## Overview

Agents are autonomous sub-agents that run tasks in the foreground or background. Each agent is defined by a `.md` file with YAML frontmatter (configuration) and a markdown body (system prompt).

## Discovery Hierarchy

Agents are loaded from three locations. Higher priority overrides lower by name:

1. **Project** (highest): `.pi/agents/<name>.md`
2. **Global**: `~/.pi/agent/agents/<name>.md`
3. **Built-in** (lowest): bundled in the extension's `agents/` directory

To override a built-in agent, create a file with the same name in `.pi/agents/`.

## File Format

```markdown
---
description: One-line description shown in the UI
tools: read, bash, grep, find, ls
model: anthropic/claude-sonnet-4-6
thinking: medium
max_turns: 25
prompt_mode: append
extensions: true
skills: true
memory: project
---

Your system prompt goes here.
This is the body text that becomes the agent's instructions.
```

## Field Reference

### `description` (string)
One-line description shown in the agent list UI and tool description. Defaults to the filename.

### `display_name` (string)
Name shown in the TUI widget and notifications. Defaults to the filename. Use this when the filename is a slug but you want a friendlier display name.

### `tools` (CSV string)
Comma-separated list of built-in tools to give this agent. Available tools:

| Tool | Capability |
|------|-----------|
| `read` | Read file contents |
| `bash` | Execute shell commands |
| `edit` | Precise text replacement |
| `write` | Create/overwrite files |
| `grep` | Search file contents |
| `find` | Find files by pattern |
| `ls` | List directory contents |

- **Omit entirely** → agent gets all tools
- **Set to `none`** → agent gets no built-in tools (may still get extension tools)
- **CSV list** → agent gets only listed tools

### `disallowed_tools` (CSV string)
Tools to explicitly block, even if extensions provide them. Useful for removing specific MCP tools.

### `model` (string)
Model override in `provider/modelId` format. Examples:
- `anthropic/claude-haiku-4-5-20251001`
- `anthropic/claude-sonnet-4-6`
- `anthropic/claude-opus-4-6`

If omitted, the agent inherits the parent session's model.

### `thinking` (string)
Extended thinking level. Values: `off`, `minimal`, `low`, `medium`, `high`, `xhigh`.

### `max_turns` (number)
Maximum agentic turns before the agent is steered to wrap up. After the limit, the agent gets a wrap-up steer. After `graceTurns` more turns (default: 5), it's force-aborted. `0` or omitted = unlimited.

### `prompt_mode` (string)
Controls how the system prompt is built:

**`replace`** (default) — The agent gets:
1. Environment header (cwd, git branch, platform)
2. Your system prompt body

The agent has no knowledge of the parent's system prompt, AGENTS.md, skills, or conversation context.

**`append`** — The agent gets:
1. Environment header
2. Parent's full system prompt (wrapped in `<inherited_system_prompt>`)
3. Sub-agent context bridge (tool usage guidance)
4. Your instructions (wrapped in `<agent_instructions>`)

Use `append` for specialists that need the project's rules and context.

### `extensions` (bool or CSV)
Controls which pi extensions the agent can use:
- `true` (default) — all parent extensions
- `false` — no extensions
- CSV list — only named extensions

### `skills` (bool or CSV)
Same as `extensions` but for pi skills.

### `inherit_context` (bool)
If `true`, the agent receives the parent conversation history. Useful when the agent needs to understand what's been discussed.

### `run_in_background` (bool)
If `true`, the agent defaults to background execution when spawned.

### `isolated` (bool)
If `true`, the agent gets no extension or MCP tools — only built-in tools from `tools`.

### `memory` (string)
Enables persistent memory for this agent. The agent gets a dedicated directory for storing knowledge across sessions.

| Value | Directory |
|-------|-----------|
| `user` | `~/.pi/agent-memory/<agent-name>/` |
| `project` | `.pi/agent-memory/<agent-name>/` |
| `local` | `.pi/agent-memory-local/<agent-name>/` |

The agent receives instructions to maintain a `MEMORY.md` index file (first 200 lines injected into the prompt).

### `isolation` (string)
- `worktree` — Agent runs in a temporary git worktree. Changes are committed to a branch on completion, keeping the main working directory clean.

### `enabled` (bool)
Set to `false` to hide this agent from the registry without deleting the file.

## System Prompt Tips

- The body text after the frontmatter `---` becomes the agent's system prompt
- For `append` mode, keep the prompt focused on role-specific instructions — the parent context is already inherited
- For `replace` mode, include all necessary context since the agent starts from scratch
- Use markdown headers to structure long prompts
- Use explicit constraints (e.g., "You have NO write tools") to reinforce tool restrictions

## Examples

### Read-only analyst
```markdown
---
description: Codebase analyst with no write access
tools: read, bash, grep, find, ls
model: anthropic/claude-haiku-4-5-20251001
prompt_mode: replace
---

You analyze code. Do NOT attempt to modify any files.
Report findings with file paths and line numbers.
```

### Background worker with memory
```markdown
---
description: Documentation writer that remembers project conventions
tools: read, bash, edit, write, grep, find, ls
prompt_mode: append
run_in_background: true
memory: project
---

Write clear documentation following this project's conventions.
Check your memory for previously documented patterns before writing.
```

### Isolated security scanner
```markdown
---
description: Security scanner — no external tools
tools: read, bash, grep, find, ls
isolated: true
thinking: high
max_turns: 40
prompt_mode: replace
---

Scan for security vulnerabilities. Report severity, location, and fix.
```
