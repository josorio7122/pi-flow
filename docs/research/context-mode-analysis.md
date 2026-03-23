# context-mode — MCP Context Management System

Source: [github.com/mksglu/context-mode](https://github.com/mksglu/context-mode)
Date captured: 2026-03-23

---

## What It Is

An MCP server that prevents AI coding assistants from flooding their own context windows. Instead of dumping raw command output into conversation, it executes code in sandboxes, indexes output into a local SQLite FTS5 knowledge base, and lets the agent search for relevant pieces.

- **40.9K users** (28.8K npm + 12.1K marketplace)
- **12 platform adapters**: Claude Code, Gemini CLI, Cursor, VS Code Copilot, Codex, OpenCode, OpenClaw, Pi, Kiro, Zed, Antigravity
- **v1.0.49**, MIT licensed
- **Benchmark**: 315 KB raw → 5.4 KB context (98% savings)

---

## Core Problem It Solves

AI agents run commands that produce huge output (test results, log files, API responses). This output floods the context window, wasting tokens and degrading reasoning. context-mode intercepts this by:

1. Running commands in sandboxed subprocesses
2. Auto-indexing large output into FTS5 knowledge base
3. Returning only relevant search results to the agent
4. Tracking session state across compaction/resume cycles

---

## Architecture

```
Agent (Claude/Gemini/Cursor/etc.)
  ↓ MCP protocol
context-mode Server (MCP tools)
  ├── Executor (polyglot sandbox — 11 languages)
  ├── ContentStore (SQLite FTS5 knowledge base)
  ├── SessionDB (event tracking + resume snapshots)
  └── Security (deny-only firewall from .claude/settings.json)
  
Hooks (platform-specific)
  ├── PreToolUse → route curl/wget to MCP tools
  ├── PostToolUse → capture events to SessionDB
  ├── PreCompact → build resume snapshot
  ├── SessionStart → inject resume context
  └── UserPromptSubmit → capture user decisions/intent
```

---

## 6 MCP Tools

| Tool | Purpose | When to Use |
|------|---------|-------------|
| `ctx_batch_execute` | Run N commands + search M queries in ONE round trip | **Primary research tool** — gather everything at once |
| `ctx_execute` | Run code in sandbox (JS/TS/Python/Shell/Ruby/Go/Rust/PHP/Perl/R/Elixir) | Single command, auto-indexes if >5KB |
| `ctx_execute_file` | Read file into `FILE_CONTENT` var, run user code to process it | Analyze logs, parse configs, extract from large files |
| `ctx_index` | Index markdown/JSON/plaintext into FTS5 knowledge base | Prepare content for later search |
| `ctx_fetch_and_index` | Fetch URL → HTML to markdown → index → preview | Web docs, API docs |
| `ctx_search` | BM25 search with progressive throttling | Follow-up queries after indexing |

### Key Workflow Pattern

```
ctx_batch_execute(
  commands: [
    { label: "README", command: "cat README.md" },
    { label: "Tests", command: "npm test 2>&1 | tail -100" }
  ],
  queries: ["what's broken", "dependencies"]
)
```

ONE round trip → runs commands → indexes ALL output → searches → returns only relevant results.

---

## Executor (Polyglot Sandbox)

11 languages supported: JavaScript, TypeScript, Python, Shell, Ruby, Go, Rust, PHP, Perl, R, Elixir

Key behaviors:
- **Bun preference**: 3-5x faster than Node for JS/TS
- **Environment denylist**: 40+ dangerous vars stripped (NODE_OPTIONS, BASH_ENV, PYTHONHOME, etc.)
- **100MB hard byte cap**: Prevents DOS from `yes` or infinite streams
- **Smart truncation**: Head (60%) + tail (40%) when output exceeds 100KB
- **Network tracking**: Wraps JS/TS to track fetch() bytes (never enters context)
- **Process group kill**: On Unix, `detached: true` for tree-kill on timeout

---

## ContentStore (FTS5 Knowledge Base)

### Schema

```sql
-- Porter stemming for English
CREATE VIRTUAL TABLE chunks USING fts5(..., tokenize='porter unicode61');
-- Trigram for fuzzy/typo matching
CREATE VIRTUAL TABLE chunks_trigram USING fts5(..., tokenize='trigram');
-- Source tracking
CREATE TABLE sources (id, label, chunk_count, indexed_at);
-- Vocabulary for search hints
CREATE TABLE vocabulary (word TEXT PRIMARY KEY);
```

### Chunking Strategies

| Content Type | Strategy |
|-------------|----------|
| **Markdown** | Split by H1-H4 headings, keep code blocks intact, split >4KB at paragraph boundaries |
| **Plain text** | Split on blank lines OR fixed 20-line groups with 2-line overlap |
| **JSON** | Walk object tree, key paths as titles, batch arrays by size |

### Search Pipeline (3-Layer Fallback)

1. **RRF (Reciprocal Rank Fusion)**: Blend BM25 (porter/stemming) + trigram (fuzzy)
2. **Proximity reranking**: Boost results where query terms appear close together
3. **Fuzzy correction**: On zero results, Levenshtein (1-3 edits) to fix typos, re-run

### Vocabulary Extraction

- Extracts 3+ char words (excluding stopwords)
- Scores by IDF + length bonus + identifier bonus (camelCase/snake_case)
- Returns top 40 distinctive terms per source → used as search hints

---

## Session Management

### SessionDB (Per-Project SQLite)

3 tables: `session_events`, `session_meta`, `session_resume`

**13 event categories extracted:**

| Category | Examples | Priority |
|----------|---------|----------|
| file | file_read, file_write, file_edit | P1 |
| rule | CLAUDE.md reads, .claude/ config | P1 |
| task | task_create, task_update | P1 |
| cwd | directory changes | P2 |
| error | tool errors, bash exit codes | P2 |
| git | branch, commit, merge, push | P2 |
| env | activate, export, npm install | P2 |
| decision | user corrections, preferences | P2 |
| skill | skill invocations | P3 |
| subagent | launched, completed | P3/P2 |
| mcp | MCP tool calls | P3 |
| intent | investigate/implement/discuss/review | P4 |
| data | large user pastes (>1KB) | P4 |

### Deduplication + Eviction

- **Hash-based dedup**: SHA256 first 16 chars, checks last 5 events
- **FIFO eviction**: Max 1000 events/session, evict lowest priority first
- **Worktree isolation**: Each worktree gets own DB via hash suffix

### Resume Snapshots (XML, <2KB)

Budget allocation:
- **P1 (50%)**: active_files, task_state, rules — always survive
- **P2 (35%)**: decisions, errors, env — survive unless budget crisis
- **P3-P4 (15%)**: intent, MCP tools, subagents — dropped first

```xml
<session_resume compact_count="2" events_captured="142">
  <active_files>
    <file path="src/api.ts" ops="edit:3,read:1" last="edit" />
  </active_files>
  <task_state>
    - Fix authentication flow
  </task_state>
  <rules>
    - CLAUDE.md
  </rules>
  <errors_encountered>
    - TypeError in payment service
  </errors_encountered>
</session_resume>
```

---

## Hooks System (Cross-Platform)

### Hook Chain

```
UserPromptSubmit → extract user events → SessionDB
PostToolUse → extract tool events → SessionDB  
PreToolUse → route decisions → format for platform → block/modify/pass
PreCompact → build resume snapshot → SessionDB
SessionStart → inject resume context → conversation
```

### PreToolUse Routing

| Tool | Routing Decision |
|------|-----------------|
| **Bash** curl/wget | → `ctx_fetch_and_index` |
| **Bash** inline HTTP | → `ctx_execute` sandbox |
| **Bash** >20 lines | → `ctx_batch_execute` or `ctx_execute` |
| **Read** for analysis | → `ctx_execute_file` (guidance) |
| **Grep** large results | → `ctx_execute` sandbox (guidance) |
| **WebFetch** | → Always denied → `ctx_fetch_and_index` |

### Platform Adapters (12 Platforms)

| Adapter | Paradigm | Hooks? | Routing? |
|---------|----------|--------|----------|
| Claude Code | JSON stdin/stdout | ✅ Full | ✅ |
| Cursor | JSON stdin/stdout | ✅ Pre/Post | ✅ |
| Gemini CLI | JSON stdin/stdout | ✅ Full | ✅ |
| VS Code Copilot | JSON stdin/stdout | ✅ Full | ✅ |
| Kiro | JSON (exit codes) | ✅ Pre/Post | ✅ |
| OpenCode | TS plugin | ✅ Full | ✅ |
| OpenClaw | TS plugin | ✅ Full | ✅ |
| Pi | Native extension | ✅ Full (events) | ✅ |
| Codex | MCP only | ❌ | ❌ (instructions only) |
| Zed | MCP only | ❌ | ❌ |
| Antigravity | MCP only | ❌ | ❌ |

### Pi Extension (`src/pi-extension.ts`)

Native Pi integration via event listeners (no hooks):

| Event | Action |
|-------|--------|
| `session_start` | Initialize SessionDB |
| `tool_call` | Block bash with HTTP patterns |
| `tool_result` | Extract and store events |
| `before_agent_start` | Inject resume snapshot |
| `session_before_compact` | Build resume snapshot |
| `session_shutdown` | Cleanup old sessions |

---

## Security

### Multi-Layer Deny Firewall

1. **Bash deny patterns**: Reads `.claude/settings.json` → `permissions.deny` → splits chained commands (`&&`, `||`, `;`, `|`) → checks each segment
2. **File path deny globs**: Converts `Read(.env)`, `Read(**/*.secret*)` to regex
3. **Shell-escape detection**: Scans non-shell code for `os.system()`, `exec()`, backticks across all languages
4. **Three-tier settings**: project-local → project-shared → global (earlier overrides)

---

## Anti-Patterns (From Their Docs)

1. ❌ Using `execute` for <20 lines → just use Bash
2. ❌ Forgetting `print`/`console.log` → stdout lost silently
3. ❌ Complex data processing in Bash → switch to JS/Python
4. ❌ Loading entire files with Read then analyzing → use `execute_file`
5. ❌ Not serializing objects → prints `[object Object]`
6. ❌ Timeouts too short for network ops → 15-30s for API, 120s for builds
7. ❌ Vague `summary_prompt` → be specific about metrics

---

## Key Design Principles

1. **No context flooding** — raw output stays in sandbox; only summaries enter conversation
2. **Batch over sequential** — `batch_execute` runs N commands + M queries in ONE round trip
3. **Intent-driven search** — when output >5KB and intent provided, auto-index and return section titles instead of full content
4. **Priority-based budgeting** — events ranked P1-P4; snapshots drop low-priority first
5. **Progressive throttling** — after 3 search calls in 60s, limits results; after 8, blocks
6. **Graceful degradation** — hooks never block sessions; extraction errors are silent
7. **Cross-platform abstraction** — normalized decisions + platform-specific formatters
8. **Worktree isolation** — each worktree gets own session DB
9. **Pure functions** — extraction and snapshot building have zero side effects

---

## How It Compares

| Aspect | context-mode | gstack /browse |
|--------|-------------|----------------|
| **Focus** | Context window management | Full engineering workflow |
| **Core tech** | SQLite FTS5 knowledge base | Persistent Chromium daemon |
| **Platform support** | 12 platforms | Claude Code primary |
| **# Tools** | 6 MCP tools | 28 skills |
| **Main innovation** | Sandbox + auto-index + search | Headless browser + role-based skills |
| **Session handling** | Event DB + resume snapshots | N/A (skills are stateless) |
| **Token savings** | 96-98% measured | N/A (different problem) |

**They're complementary**: context-mode manages the context window while gstack provides the workflows.

---

## Benchmark Results

| Scenario | Raw Size | Context Size | Savings |
|----------|----------|-------------|---------|
| ctx_execute_file (Part 1) | 315 KB | 5.5 KB | 98% |
| ctx_index + ctx_search (Part 2) | 60.3 KB | 11 KB | 82% |
| **Total** | **376 KB** | **16.5 KB** | **96%** |

125 test suites, all passing.

---

## Tech Stack

- **Runtime**: Bun (preferred) or Node.js
- **Database**: better-sqlite3 (FTS5, WAL mode)
- **Protocol**: MCP (@modelcontextprotocol/sdk)
- **HTML conversion**: turndown + turndown-plugin-gfm
- **Validation**: zod
- **Build**: esbuild (bundled hooks + server)
