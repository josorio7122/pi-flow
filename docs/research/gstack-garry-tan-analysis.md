# gstack — Garry Tan's AI Software Factory

Source: [github.com/garrytan/gstack](https://github.com/garrytan/gstack)
Date captured: 2026-03-23

---

## What It Is

Garry Tan's (YC CEO) open-source system that turns Claude Code into a **virtual engineering team** of 28 specialists. One person shipping 10K+ LOC/day. 600K+ LOC in 60 days.

> Andrej Karpathy: "I don't think I've typed like a line of code probably since December"

- MIT licensed, free, no premium tier
- Installs in 30 seconds: `git clone https://github.com/garrytan/gstack.git ~/.claude/skills/gstack`
- Tech stack: Bun, Playwright, compiled CLI binaries, markdown-based skill templates

---

## The 28 Skills (Full Inventory)

### Sprint Workflow: Think → Plan → Build → Review → Test → Ship → Reflect

#### 💡 Think Phase
| Skill | What It Does |
|-------|-------------|
| `/office-hours` | YC-style startup diagnostic — 6 forcing questions (startup mode) or design thinking brainstorm (builder mode) |
| `/design-consultation` | Creates complete design systems, generates DESIGN.md as source of truth |

#### 📋 Plan Phase
| Skill | What It Does |
|-------|-------------|
| `/plan-ceo-review` | CEO/founder-mode: rethink problem, find 10-star product, challenge premises. 4 scope modes |
| `/plan-eng-review` | Eng manager: lock architecture, data flow, edge cases, test coverage |
| `/plan-design-review` | Designer's eye: rates each dimension 0-10, explains what makes it a 10 |
| `/autoplan` | Runs CEO + Design + Eng reviews sequentially with auto-decisions. 6 decision principles |

#### 🔨 Build Phase
| Skill | What It Does |
|-------|-------------|
| `/browse` | Persistent headless Chromium (~100ms/command). Navigate, click, fill, screenshot, snapshot, diff |
| `/investigate` | Systematic debugging: 4 phases, Iron Law = no fixes without root cause |
| `/freeze` | Restrict edits to one directory (scoped refactoring) |
| `/unfreeze` | Remove edit restrictions |
| `/careful` | Warns before destructive commands (rm -rf, DROP TABLE, force-push) |
| `/guard` | Combined /careful + /freeze |

#### 👀 Review Phase
| Skill | What It Does |
|-------|-------------|
| `/review` | Pre-landing PR review: SQL safety, trust boundaries, conditional side effects |
| `/design-review` | Visual QA: finds & fixes inconsistencies with atomic commits + before/after screenshots |
| `/cso` | Chief Security Officer: 14-phase security audit (secrets, supply chain, OWASP, STRIDE, LLM security) |
| `/codex` | OpenAI Codex wrapper: code review, adversarial challenge, consultation modes |

#### 🧪 Test Phase
| Skill | What It Does |
|-------|-------------|
| `/qa` | Full QA cycle: test → find bugs → fix atomically → re-verify (3 tiers: Quick/Standard/Exhaustive) |
| `/qa-only` | Report-only QA (no fixes) with health scores & repro steps |
| `/benchmark` | Performance regression detection: baselines, Core Web Vitals, bundle sizes |

#### 🚀 Ship Phase
| Skill | What It Does |
|-------|-------------|
| `/ship` | Full ship: merge base, tests, review, bump VERSION, CHANGELOG, push, open PR |
| `/land-and-deploy` | Post-ship: merge PR, wait for CI/deploy, verify prod health via canary |
| `/setup-deploy` | Auto-detect deploy platform (Fly/Render/Vercel/Netlify/Heroku) & configure |
| `/canary` | Post-deploy monitoring: watches for errors, perf regressions, page failures |

#### 🔄 Reflect Phase
| Skill | What It Does |
|-------|-------------|
| `/retro` | Weekly retro: per-person breakdowns, trend tracking, code quality metrics |
| `/document-release` | Post-ship docs sync: updates README, ARCHITECTURE, CHANGELOG |

#### 🔧 Utility
| Skill | What It Does |
|-------|-------------|
| `/gstack-upgrade` | Upgrade gstack to latest version |
| `/setup-browser-cookies` | Import cookies from real browser for authenticated testing |

---

## Architecture Decisions

### Browse Daemon (Persistent Headless Chromium)

The crown jewel — a long-lived browser server, not one-off browser per command.

```
CLI ($B command) → HTTP POST /command → Daemon (Playwright) → Chromium
                    ↑ Bearer token auth      ↑ persistent state
                    ↑ localhost only          ↑ cookies, tabs, sessions
```

**Why daemon model:**
- ~3s first call (launch Chromium), ~100-200ms subsequent
- Persistent state: cookies, localStorage, login sessions, open tabs
- Written in Bun (compiled binary, native SQLite, native TS)
- Auto-start on first use, auto-shutdown after 30 min idle

**Server internals:**
- Random port 10000-60000, Bearer token auth (UUID)
- State file: `.gstack/browse.json` (pid, port, token) — atomic writes
- 3 circular buffers: console (1000), network (500), dialog (100) — O(1) push
- Async flush to disk every 1s — survives crashes with max 1s data loss
- Chromium crash → process.exit(1) → CLI auto-restarts

**Command categories:**
- READ (13): text, html, links, forms, js, css, console, cookies, etc.
- WRITE (19): goto, click, fill, select, hover, type, cookie, upload, etc.
- META (10): tabs, screenshot, snapshot, chain, diff, handoff, responsive

**Ref system (@e1, @e2, @c1):**
- Semantic element addressing via Playwright Locators + ARIA accessibility tree
- NOT DOM mutation — avoids CSP issues, framework hydration conflicts, Shadow DOM problems
- Stale refs detected via async `.count()` check

**Snapshot flags:**
- `-i` interactive only, `-c` compact, `-d N` depth limit
- `-D` diff vs previous, `-a` annotated screenshots with ref labels
- `-o path` output to file, `-C` cursor refs

### Security Model

- Localhost-only binding + Bearer token auth
- Cookie decryption: PBKDF2 + AES-128-CBC, in-memory only, never written to disk
- Read-only access to Chromium's cookie database
- macOS Keychain access requires user approval

### SKILL.md Template System

```
SKILL.md.tmpl (human-editable) → gen-skill-docs.ts → SKILL.md (generated)
```

- Never hand-edit SKILL.md — always edit .tmpl
- Templates use placeholders filled at build time
- Three test tiers: static validation (free, <2s), E2E (paid, ~$3.85), LLM-as-judge (~$0.15)

---

## Key Skills Deep Dive

### CSO (Chief Security Officer) — 14 Phases

| Phase | What |
|-------|------|
| 0-1 | Stack detection, attack surface census |
| 2 | Git history secrets archaeology, .env tracking |
| 3 | Dependency supply chain (npm/pip/gem audit) |
| 4 | CI/CD pipeline security (unpinned actions, script injection) |
| 5-6 | Infrastructure shadow surface, webhook audit |
| 7 | LLM/AI security (prompt injection, unsanitized output) |
| 8 | Skill supply chain scanning (36% have flaws, 13.4% malicious) |
| 9-10 | OWASP Top 10 + STRIDE threat modeling |
| 11 | Data classification |
| 12 | False positive filtering + active verification |
| 13-14 | Findings report + trend tracking |

Two modes: daily (8/10 confidence gate) vs comprehensive (2/10). 23 hard exclusion rules. Precedent-based FP filtering.

### Ship — Fully Automated Pre-Merge

| Step | What |
|------|------|
| 0 | Detect base branch |
| 1 | Pre-flight + Review Readiness Dashboard |
| 2 | Merge base branch |
| 2.5 | Test framework bootstrap (auto-detect, install, generate 3-5 tests) |
| 3 | Run tests + Test Failure Ownership Triage |
| 3.25 | Eval suites (when prompt files change) |
| 3.4 | Test Coverage Audit (trace codepaths, ASCII diagram, generate missing tests) |
| 4 | Version bump (auto-pick MICRO/PATCH) |
| 5 | Commit, push, create PR |

### Autoplan — Automated Review Pipeline

Runs CEO → Design → Eng reviews sequentially with 6 decision principles:
1. Completeness — boil the lake
2. Pragmatic — prefer simple
3. DRY — don't repeat
4. Explicit — over clever
5. Action bias — decide, don't deliberate forever
6. Premise confirmation is the ONE non-auto-decided gate

Required outputs: architecture diagrams, test diagram mapping codepaths, decision audit trail.

### Investigate — Systematic Debugging

4 phases: Investigate → Analyze → Hypothesize → Implement

- **Iron Law:** no fixes without root cause
- **3-strike rule:** 3 failed hypotheses → escalate
- **Scope lock:** `/freeze` to affected directory
- Pattern library: race conditions, nil propagation, state corruption, integration failures, config drift, stale cache
- Regression test mandatory before shipping fix

### Design Review — Visual QA

10-category checklist:
1. Hierarchy
2. Typography
3. Color
4. Spacing
5. Interaction states
6. Responsive
7. Motion
8. Content
9. AI slop detection (purple gradients, 3-column feature grids, centered everything)
10. Performance

Fixes issues atomically with before/after screenshots. Uses browse daemon for visual testing.

---

## Test Infrastructure

### Three Test Tiers

| Tier | Cost | Speed | What |
|------|------|-------|------|
| Static validation | Free | <2s | Skill parsing, command validation, snapshot flags |
| E2E | ~$3.85 | Minutes | Spawns Claude as subprocess, runs full skill workflows |
| LLM-as-judge | ~$0.15 | Seconds | Scores output quality on clarity/completeness/actionability |

### Session Runner Pattern

```
Spawn `claude -p` subprocess → pipe NDJSON → parse real-time → track metrics
```

- Pure parser: `parseNDJSON()` is testable (separates I/O from logic)
- Tracks: turns, tool calls, first-response latency, inter-turn peak latency
- Cost tracking from Anthropic API response
- Browse error detection: scans for known patterns

### Diff-Based Test Selection

Only runs tests if relevant files changed:
```
git diff BASE...HEAD → changed files → touchfile map → selected tests
```

Avoids running full $4 suite when only one skill changed.

### Eval Store

- Accumulates test results to `~/.gstack-dev/evals/{version}-{branch}-{tier}-{timestamp}.json`
- Auto-compares with previous run: shows deltas in pass/fail, cost, duration
- Commentary generation: interprets regressions + efficiency wins

---

## CLI Scripts (bin/)

| Script | Purpose |
|--------|---------|
| `dev-setup` | Symlinks repo → `~/.claude/skills/gstack` for development |
| `dev-teardown` | Removes dev symlinks, restores global install |
| `gstack-analytics` | Personal usage dashboard from local JSONL (7d/30d/all) |
| `gstack-community-dashboard` | Community stats from Supabase |
| `gstack-config` | Read/write `~/.gstack/config.yaml` (get/set/list) |
| `gstack-diff-scope` | Categorizes diff: SCOPE_FRONTEND, SCOPE_BACKEND flags |
| `gstack-global-discover.ts` | Discovers AI sessions across Claude/Codex/Gemini |
| `gstack-repo-mode` | Detects solo (≥80% commits) vs collaborative mode |
| `gstack-review-log` | Logs review results to JSONL |
| `gstack-review-read` | Reads review log for dashboard display |
| `gstack-slug` | Outputs project slug + sanitized branch name |
| `gstack-telemetry-log` | Appends telemetry event to local JSONL |
| `gstack-telemetry-sync` | Syncs events to Supabase (fire-and-forget, 5min rate limit) |
| `gstack-update-check` | Periodic version check |

---

## Project Structure

```
gstack/
├── {skill}/                  # 28 skill directories
│   ├── SKILL.md.tmpl         # Human-editable template
│   ├── SKILL.md              # Generated (don't edit)
│   └── bin/                  # Optional helper scripts
├── browse/                   # Headless browser
│   ├── src/
│   │   ├── server.ts         # HTTP daemon (Playwright)
│   │   ├── cli.ts            # CLI wrapper
│   │   ├── browser-manager.ts # Playwright lifecycle
│   │   ├── commands.ts       # Command registry
│   │   ├── read-commands.ts  # 13 read commands
│   │   ├── write-commands.ts # 19 write commands
│   │   ├── meta-commands.ts  # 10 meta commands
│   │   ├── snapshot.ts       # Accessibility tree + refs
│   │   ├── config.ts         # Path resolution
│   │   └── buffers.ts        # CircularBuffer
│   └── dist/browse           # Compiled binary
├── bin/                      # 14 CLI utilities
├── test/
│   ├── helpers/
│   │   ├── session-runner.ts # Spawns claude -p subprocess
│   │   ├── gemini-session-runner.ts
│   │   ├── llm-judge.ts      # LLM scoring
│   │   ├── eval-store.ts     # Eval comparison
│   │   ├── skill-parser.ts   # SKILL.md validation
│   │   └── e2e-helpers.ts    # Shared DRY setup
│   └── *.test.ts             # Test files
├── scripts/                  # Build tooling
├── supabase/                 # Supabase config + migrations
├── ARCHITECTURE.md           # Deep technical decisions
├── AGENTS.md                 # Agent configuration
├── CLAUDE.md                 # Development guide
├── conductor.json            # Conductor workspace config
└── package.json              # Bun project
```

---

## Key Design Principles

1. **Skills feed into skills** — design docs → planning → architecture → review → ship. Each output is the next input.
2. **Completeness over speed** — "boil the lake" — full coverage costs marginal time more with AI
3. **Atomic commits** — one logical change per commit, test + implementation together
4. **Iron laws** — no fixes without root cause, no shipping without tests, no deploying without canary
5. **3-strike escalation** — 3 failed hypotheses → escalate to user
6. **Decision audit trail** — all decisions logged to disk (JSONL/markdown) for visibility
7. **Diff-based efficiency** — only run tests/evals affected by changes
8. **Two repo modes** — solo (≥80% commits) vs collaborative (different review gates)
9. **Template-driven docs** — SKILL.md generated from .tmpl, never hand-maintained
10. **Safety infrastructure** — /careful, /freeze, /guard as preventive guardrails

---

## What Makes This Different

- **Not a framework** — it's a collection of markdown skill files + one compiled browser binary
- **No SDK dependency** — works with Claude Code, Codex CLI, Gemini CLI
- **Sprint-structured** — entire product lifecycle covered, not just coding
- **Adversarial by design** — security audits, design slop detection, test failure triage
- **Real browser** — not mock/simulated, actual Chromium with persistent sessions
- **Observable** — telemetry, review logs, eval comparisons, cost tracking

---

## Quotes from README

> "One founder can now have an entire engineering team's output — for the cost of an API call."

> "The most dangerous thing for a founder to do is slow down."
