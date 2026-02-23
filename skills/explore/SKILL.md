---
name: explore
description: Multi-level parallel codebase analysis for existing projects. Dispatches scouts simultaneously for product, architecture, tech stack, dependencies, and relevant code. Use at the start of any session on an existing codebase before brainstorm or planning. Produces a structured brief covering all five levels.
---

# Explore

Get a complete multi-level understanding of an existing codebase by dispatching scouts in parallel, then synthesizing their findings into a structured brief.

**Announce at start:** "I'm using the explore skill to map this codebase before we proceed."

## When to Use

- Starting work on an unfamiliar codebase
- Beginning a new session on a known project (quick refresh)
- Before brainstorm for any change to an existing system
- When a user brings a request and you need to understand context before designing

## The Five Levels

| Level | What it answers | Agent |
|---|---|---|
| **Product** | What does this do? Who uses it? What's the core workflow? | `scout` |
| **Architecture** | How is it structured? Layers, boundaries, module responsibilities? | `scout` |
| **Tech Stack** | What frameworks, versions, build system, test runner? | `scout` |
| **Dependencies** | What packages? Anything outdated, deprecated, or risky? | `researcher` |
| **Relevant Code** | What files/modules relate to the user's stated goal? | `scout` |

## Process

### Step 1: Understand the goal

Before dispatching, ask: "What are you trying to do?" if not already stated.
The "Relevant Code" scout needs a target — it can't scan without knowing what's relevant.

### Step 2: Dispatch in two phases

**Phase 1 — parallel scouts** (product, architecture, tech stack, relevant code run simultaneously):

```
subagent(tasks: [
  {
    agent: "scout",
    task: "PRODUCT LEVEL SCAN\n\nExplore this codebase and answer:\n- What does this product/service do?\n- Who are the intended users?\n- What is the core user workflow?\n- What problem does it solve?\n\nLook at: README.md, docs/, package.json description, any marketing/landing page copy, main entry points.\n\nReturn a structured summary: product purpose, user types, core workflows (2-3 sentences each), key value propositions.",
    cwd: "<project-root>"
  },
  {
    agent: "scout",
    task: "ARCHITECTURE LEVEL SCAN\n\nExplore this codebase and answer:\n- How is the code structured? (monolith, monorepo, microservices, etc.)\n- What are the main layers or modules and what does each own?\n- What are the key boundaries and dependencies between modules?\n- What is the data flow for the core use case?\n\nLook at: directory structure, package.json workspaces, imports between modules, key index files, any architecture docs.\n\nReturn: directory tree summary, module list with one-line responsibility each, key dependency graph (text), core data flow.",
    cwd: "<project-root>"
  },
  {
    agent: "scout",
    task: "TECH STACK SCAN\n\nExplore this codebase and answer:\n- What language(s) and runtime(s)?\n- What frameworks (web, API, ORM, etc.) and their versions?\n- What build system and config?\n- What test runner and testing approach?\n- What linter/formatter?\n- What CI/CD setup?\n\nLook at: package.json, pyproject.toml, Cargo.toml, go.mod, tsconfig.json, .eslintrc, vitest.config, jest.config, Dockerfile, .github/workflows, etc.\n\nReturn: structured tech inventory with exact versions. Include the full contents of the primary dependency manifest (package.json, pyproject.toml, etc.).",
    cwd: "<project-root>"
  },
  {
    agent: "scout",
    task: "RELEVANT CODE SCAN\n\nGoal: <user's stated goal>\n\nFind all code, files, and modules that are relevant to this goal.\n\n- What files will likely need to change?\n- What existing code implements similar functionality?\n- What interfaces, types, or contracts must be respected?\n- What tests cover this area?\n\nReturn: file list with one-line description of relevance, key types/interfaces to know, existing patterns to follow.",
    cwd: "<project-root>"
  }
])
```

**Phase 2 — dependency health check** (after phase 1 returns, using the dependency manifest from the tech stack scout):

```
subagent(
  agent: "researcher",
  task: "Check the dependency health for this project.\n\n<paste dependency manifest from tech stack scout>\n\nFor the top 5-10 most important dependencies:\n- Are they up to date?\n- Are any deprecated or have known security issues?\n- Are there any that have significantly better alternatives in 2025?\n\nReturn: dependency health summary, any urgent upgrades needed, any risky packages."
)
```

Phase 2 runs after phase 1 because the researcher needs the actual dependency manifest content, which the tech stack scout retrieves.

### Step 3: Synthesize

After all scouts return, synthesize into a **Codebase Brief**:

```markdown
# Codebase Brief: [Project Name]

## Product
[2-3 sentences: what it is, who uses it, core workflow]

## Architecture  
[Module map + data flow — enough to know what touches what]

## Tech Stack
| Layer | Technology | Version |
|---|---|---|
| Runtime | Node.js | 20.x |
| Framework | Next.js | 15.x |
| ... | ... | ... |

## Dependency Health
[Any urgent items. "All healthy" if nothing notable.]

## Relevant to Goal
[Files/modules relevant to what user wants to do, with blast radius estimate]

## Key Constraints
[Interfaces you must not break, patterns you must follow, things not to touch]
```

### Step 4: Present and confirm

Present the brief to the user. Ask: "Does this match your understanding? Anything I'm missing before we design the change?"

Once confirmed, invoke `brainstorm` skill with this brief as context.

## Integration

**Called before:** `brainstorm` (always, for existing codebases)
**Uses:** `scout` (parallel), `researcher` (dependency check)
**Produces:** Codebase Brief that feeds brainstorm and plan
