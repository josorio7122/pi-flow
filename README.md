# pi-flow

**A deliberate agentic development workflow for [pi](https://github.com/badlogic/pi).**

Research → brainstorm → spec → plan → execute → review → ship. Every step orchestrated through specialist subagents, with parallel execution, isolated context windows, and three-gate review per task.

```bash
pi install git:github.com/josorio7122/pi-flow
```

---

## What's included

| | Count | What |
|---|---|---|
| **Skills** | 13 | Full workflow from research through shipping |
| **Agents** | 11 | Specialist subagents for every phase |
| **Extensions** | 1 | Subagent tool with parallel + chain execution |

---

## The mental model

Two roles. One session.

**You (main session)** — the orchestrator. You answer questions during brainstorm, approve designs and plans, and watch execution. You don't write code directly.

**Agents (subprocesses)** — everything else. Reading files, writing code, running tests, committing, reviewing, searching docs. Each runs in an isolated context window that doesn't touch your token budget.

Skills guide *you* through a phase. Agents do the actual work. Skills orchestrate agents. You orchestrate skills.

```
You → Skills → Agents → Code
```

---

## The two workflows

### Existing codebase

```
explore → brainstorm → [spec] → plan → worktree → execute → review → ship
```

### Greenfield

```
research → brainstorm → [spec] → plan → worktree → execute → review → ship
```

The `[spec]` step is optional — use it for features with significant behavioral complexity. Skip it for straightforward changes.

---

## Walkthrough: adding OAuth to an existing app

### Step 1 — Understand

Load `explore`. Pi dispatches 4 scouts in parallel:

- What is this product? Who uses it?
- How is the code structured? What are the layers?
- What's the tech stack? *(returns `package.json` too)*
- Find everything related to auth, sessions, user management

While those run, you see them in the subagent panel — tool calls streaming live. When they finish, pi feeds the dependency manifest to a `researcher` agent for a health check.

Result: a **Codebase Brief** — product summary, architecture map, tech stack, relevant files, dependency health. Pi presents it and asks if it matches your understanding.

### Step 2 — Brainstorm

Load `brainstorm`. Pi is now in the main session with the full brief as context. It asks one question at a time:

> *"Are you integrating with a specific OAuth provider, or multiple?"*
> *"Should existing password-based accounts be mergeable with OAuth?"*

After a few rounds, it proposes 2–3 approaches with trade-offs and a recommendation. You pick one. It walks through the design section by section, getting approval on each. When you're satisfied, it saves a design doc to `docs/plans/` and commits it.

### Step 3 — Spec *(if needed)*

Load `spec` for features with cross-cutting effects — auth touches sessions, user model, API middleware, and frontend. It interviews you systematically and produces a complete behavioral spec: data model, API contract, UI behavior, edge cases. This becomes the source of truth the `spec-reviewer` agent checks against later.

Skip this for simpler features.

### Step 4 — Plan

Load `plan`. With the design doc in context, pi writes a detailed implementation plan. Not vague bullets — actual code, exact file paths, TDD steps with expected test output:

```
Task 1: Add OAuth provider config
Files: src/auth/oauth.ts (new), src/config/index.ts (modify)

1. Write failing test
   test('loads OAuth config from env', () => { ... })
   Run: npm test src/auth/oauth.test.ts → FAIL

2. Implement
   export const oauthConfig = { ... }

3. Run tests → PASS

4. Commit: "feat: add OAuth provider config"
```

Every task is self-contained enough that a subagent with no prior context can execute it from the text alone.

### Step 5 — Worktree

Load `worktree`. Pi checks for `.worktrees/`, verifies it's gitignored, creates `.worktrees/feature/oauth-login`, runs `npm install`, runs the full test suite.

> *"47 tests passing. Ready."*

### Step 6 — Execute

Load `execute`. For each task, pi dispatches a fresh `implementer` subagent with the full task text. The implementer:

1. **Checks it's on a feature branch** — hard stops if on `main`/`master`
2. Writes the failing test
3. Watches it fail
4. Writes minimal code to pass
5. Commits
6. Self-reviews
7. **Writes status to `docs/plans/PROGRESS.md`** — so the next session can resume exactly where you left off

Then pi runs the three gates:

```
Gate 1: spec-reviewer   — did it match the spec?        ✅ pass → Gate 2
Gate 2: code-reviewer — is it well-written?     ✅ pass → Gate 3
Gate 3: security-reviewer — any security issues?        ✅ pass → next task
                                                        ❌ fail → re-dispatch implementer with exact issue list → re-check
```

When all tasks complete, pi dispatches the `branch-reviewer` agent for a final holistic pass over the entire branch diff.

### Step 7 — Ship

Load `ship`. Pi:

1. Checks commit history — squashes if messy
2. `git push -u origin HEAD`
3. `gh pr create` with a formatted PR description
4. `git worktree remove .worktrees/feature/oauth-login`

You get a PR URL.

---

## Agents

| Agent | Model | Role |
|---|---|---|
| `scout` | haiku | Fast codebase recon — parallel sweeps |
| `researcher` | haiku | Docs, best practices, version lookups. Saves findings to `docs/research/` |
| `architect` | sonnet | Design decisions, ADRs |
| `implementer` | sonnet | TDD implementation, commits, self-review. Writes `PROGRESS.md` after each task |
| `spec-reviewer` | sonnet | Gate 1 — spec compliance check |
| `code-reviewer` | sonnet | Gate 2 — code quality check |
| `security-reviewer` | sonnet | Gate 3 — security audit |
| `debugger` | sonnet | Root cause analysis, surgical fix |
| `reviewer` | sonnet | Final holistic review of entire branch |
| `documenter` | haiku | README, CHANGELOG, inline docs |
| `worker` | sonnet | Last-resort fallback |

**Haiku** — fast and cheap, used for parallel sweeps and straightforward tasks.
**Sonnet** — used where decisions, code quality, and judgment matter.

---

## Skills

### Workflow order

```
research / explore → brainstorm → [spec] → plan
→ worktree → execute → ship
```

### Full reference

| Skill | When to use |
|---|---|
| `research` | Starting a new project or adopting unfamiliar tech |
| `explore` | Start of any session on an existing codebase |
| `brainstorm` | Before any feature work — explores intent, proposes approaches |
| `spec` | Non-trivial features with behavioral complexity |
| `plan` | After design approval — creates the implementation plan |
| `worktree` | Before implementation — sets up isolated workspace |
| `execute` | Executes the plan with three-gate review per task |
| `ship` | After all tasks pass — squash, push, PR, cleanup |
| `pr-review` | Given a GitHub PR URL to review |
| `exa-search` | Semantic search, AI answers, doc page fetching |
| `brave-search` | Keyword web search, news, official reference pages |
| `frontend-design` | Web pages, landing pages, marketing sites |
| `interface-design` | Dashboards, admin panels, application UI |

### Force-loading a skill

Skills activate automatically when the task matches. To force-load:

```
/skill:brainstorm
/skill:explore
/skill:plan
/skill:execute
/skill:ship
/skill:pr-review
```

---

## PR review

Load the skill with `/skill:pr-review` or paste a GitHub PR URL. It:

1. Fetches full diff, all comments, all reviews, and CI status via `gh` CLI
2. Reads every changed file in full
3. Reads callers, test files, and related types
4. Flags unresolved review comments
5. Produces a structured review: **Good / Bad / Ugly / Tests / Summary**

---

## Resuming a mid-feature session

The implementer writes status to `docs/plans/PROGRESS.md` after every commit. When you return to a feature in a new session, load `execute` — it reads that file first and boots from the last completed task.

---

## When things go wrong

| Situation | Action |
|---|---|
| Implementer fails | Dispatch `debugger` with the error output — it traces root cause surgically |
| Spec-reviewer keeps failing | Implementer is missing something — re-dispatch with reviewer's exact findings |
| Security-reviewer flags something | Fix it now. Dispatch implementer with the findings, re-run security review |
| Main session context is getting large | Stop reading files directly — dispatch a `scout` to summarize instead |

---

## Setup

**Requirements:**

- [pi](https://github.com/badlogic/pi) installed
- `gh` CLI installed and authenticated *(for pr-review)*
- `EXA_API_KEY` in your shell profile *(for exa-search)*
- `BRAVE_API_KEY` in your shell profile *(for brave-search)*

**After install, run once:**

```bash
cd ~/.pi/agent/git/github.com/josorio7122/pi-flow

npm install --prefix skills/exa-search
npm install --prefix skills/brave-search
npm install --prefix skills/pr-review
```

---

## Full reference

The complete workflow design — all phases, agent selection guide, dispatch rules, and system map — lives in [`WORKFLOW.md`](./WORKFLOW.md).
