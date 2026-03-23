# Pi Extensions & Justfile — Learnings

Date captured: 2026-03-23

---

## The Key Idea: Load Only What You Need

Instead of loading every extension globally (bloated, slow), use `-e` to load per-session:

```bash
pi                                    # plain pi, no extensions
pi -e ./extensions/video-analyst.ts   # video analysis session
pi -e ./extensions/ceo-and-board.ts   # CEO & Board deliberation
pi -e ./ext1.ts -e ./ext2.ts          # multiple extensions
```

Each session gets exactly the tools it needs. No bloat.

---

## Pi Extension Architecture

### Export Pattern

Every extension is one function:

```typescript
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";

export default function(pi: ExtensionAPI) {
  // Register tools (LLM-callable)
  pi.registerTool({ name, parameters, execute });

  // Register commands (/command in chat)
  pi.registerCommand("my-cmd", { handler });

  // Subscribe to events
  pi.on("session_start", (event, ctx) => { ... });
}
```

No return value. Side effects only (registration + event subscription).

### Three Loading Methods

| Method | Location | Scope | Hot-reload? |
|--------|----------|-------|-------------|
| **Per-session** `-e` | `pi -e ./ext.ts` | This session only | No (restart needed) |
| **Project-local** | `.pi/extensions/ext.ts` | This project | Yes (`/reload`) |
| **Global** | `~/.pi/agent/extensions/ext/index.ts` | All projects | Yes (`/reload`) |

### Extension File Structures

**Single file (simplest):**
```
extensions/my-tool.ts
```

**Directory (multi-file):**
```
extensions/my-tool/
├── index.ts       # entry point
├── tools.ts
└── utils.ts
```

**With npm dependencies:**
```
extensions/my-tool/
├── package.json   # declares deps
├── node_modules/
└── index.ts
```

TypeScript runs directly via jiti — no build step needed.

### Tool Registration

```typescript
pi.registerTool({
  name: "analyze_video",
  label: "Analyze Video",
  description: "Analyze a YouTube video using Gemini",
  promptSnippet: "Analyze YouTube videos with multimodal AI",

  parameters: Type.Object({
    url: Type.String({ description: "YouTube URL" }),
    focus: Type.Optional(Type.String({ description: "Focus area" })),
  }),

  async execute(toolCallId, params, signal, onUpdate, ctx) {
    // Stream progress
    onUpdate?.({ content: [{ type: "text", text: "Analyzing..." }] });

    // Do work (API calls, file I/O, etc.)
    const result = await analyzeVideo(params.url);

    // Return to LLM
    return {
      content: [{ type: "text", text: result }],
      details: { url: params.url }
    };
  },

  // Optional: custom rendering in terminal
  renderCall(args, theme, ctx) { ... },
  renderResult(result, options, theme, ctx) { ... }
});
```

### ExtensionAPI Surface (Key Methods)

```typescript
pi.on(event, handler)           // Subscribe to events
pi.registerTool(def)            // LLM-callable tool
pi.registerCommand(name, def)   // /command handler
pi.registerShortcut(key, def)   // Keyboard shortcut
pi.sendMessage(msg)             // Inject message into session
pi.sendUserMessage(content)     // Queue follow-up prompt
pi.exec(cmd, args)              // Run bash command
pi.setModel(model)              // Change active model
pi.registerProvider(name, cfg)  // Add model provider
pi.getActiveTools()             // List active tools
pi.setActiveTools(names)        // Enable/disable tools
```

### Event Lifecycle (Key Events)

**Session:**
- `session_start` — initial load
- `session_shutdown` — exit

**Agent flow:**
- `before_agent_start` — inject context before LLM call
- `agent_end` — after LLM responds
- `context` — modify messages before LLM (non-destructive)

**Tools:**
- `tool_call` — can block tool execution
- `tool_result` — can modify result
- `tool_execution_start/end` — track tool lifecycle

**User:**
- `input` — intercept/transform user messages

### ExtensionContext (What Handlers Receive)

```typescript
ctx.ui.confirm(title, msg)      // → boolean
ctx.ui.input(title, placeholder) // → string
ctx.ui.select(title, items)     // → string
ctx.ui.notify(message, level)   // toast notification
ctx.cwd                         // working directory
ctx.model                       // current model
ctx.isIdle()                    // is agent streaming?
ctx.abort()                     // cancel running agent
ctx.getSystemPrompt()           // current system prompt
ctx.compact(options)            // trigger compaction
```

---

## Justfile — Command Runner

### What it is

A modern command runner (like Make, but for tasks not builds). Define recipes in a `justfile`, run with `just <recipe>`.

```bash
brew install just
```

### Basic Syntax

```justfile
set shell := ["bash", "-uc"]
set dotenv-load

# Default: show available commands
[default]
help:
    @just --list

# Simple recipe
test:
    cargo test

# With arguments
deploy env='staging':
    echo "Deploying to {{env}}"

# With dependencies (test runs before build)
build: test lint
    cargo build --release

# Confirmation prompt
[confirm("Deploy to PROD?")]
deploy-prod: build
    terraform apply

# Variadic arguments
backup +FILES:
    tar czf backup.tar.gz {{FILES}}
```

### Key Features

| Feature | Syntax |
|---------|--------|
| Variables | `version := "1.0"` |
| Env vars | `export DB_URL := "postgres://..."` |
| Backtick eval | `git_hash := \`git rev-parse --short HEAD\`` |
| String interpolation | `echo "Version: {{version}}"` |
| Default args | `deploy env='staging':` |
| OS detection | `if os() == "macos" { ... }` |
| Private recipes | `_helper:` or `[private]` |
| Load .env | `set dotenv-load` |
| Parallel deps | `[parallel]` attribute |
| Shebang recipes | `#!/usr/bin/env python3` |

### Why Just > Make for Task Running

| Aspect | Make | Just |
|--------|------|------|
| Purpose | Build system | Task runner |
| `.PHONY` needed? | Yes | No (all recipes are "phony") |
| Discoverability | No `--list` | `just --list` built-in |
| Arguments | Awkward | First-class: `recipe arg1 arg2` |
| Syntax | Cryptic (`$@`, `$<`) | Bash-compatible, readable |
| Error messages | Cryptic | Specific, contextual |

---

## The Pattern: Just as Pi Launcher

`just` becomes the launcher for different Pi modes:

```justfile
set shell := ["bash", "-uc"]

# Plain pi
pi:
    pi

# Video analysis mode
video:
    pi -e ./extensions/video-analyst.ts

# CEO & Board deliberation
ceo:
    pi -e ./extensions/ceo-and-board.ts

# Research mode
research:
    pi -e ./extensions/video-analyst.ts -e ./extensions/research.ts

# Full power mode
full:
    pi -e ./extensions/video-analyst.ts -e ./extensions/ceo-and-board.ts
```

Then: `just ceo`, `just video`, `just research` — clean, discoverable, no mental overhead.

---

## Key Takeaways

1. **Extensions are the unit of composition** — each `.ts` file registers specific tools/commands for a specific purpose
2. **`-e` flag = selective loading** — only load what this session needs
3. **`just` = the launcher** — wraps `pi -e` invocations into discoverable recipes
4. **No build step** — TypeScript runs directly via jiti
5. **Tools vs Skills** — extensions register tools (LLM calls them natively); skills are instructions + scripts (agent runs them via bash)
6. **Dan's pattern:** one extension per domain (ceo-and-board.ts), loaded with `just ceo`, registers domain-specific tools (`converse`, `condense`), manages its own state files
