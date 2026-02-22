---
name: subagent-driven-development
description: Use when executing implementation plans with independent tasks in the current session. Dispatches fresh subagents per task with two-stage review (spec compliance, then code quality).
---

# Subagent-Driven Development

Execute a plan by dispatching a fresh subagent per task, with three-gate review after each: spec compliance, then code quality, then security.

**Core principle:** Fresh subagent per task + three-gate review = high quality, fast iteration.

## How This Uses Pi

This skill orchestrates the `subagent` tool. Each dispatch is a single `subagent()` call with a named agent and a task string containing all needed context. The controller (you, in this session) handles the review loop logic — deciding whether to re-dispatch based on reviewer output.

**Named agents used:**
- `implementer` — implements, tests (TDD), commits, self-reviews
- `spec-reviewer` — verifies implementation matches spec (nothing missing, nothing extra)
- `code-quality-reviewer` — verifies implementation is well-built (after spec passes)
- `security-reviewer` — audits diff for secrets, injection, auth gaps, OWASP issues (after quality passes)

All three agents live in `~/.pi/agent/extensions/subagent/agents/`. Their system prompts contain their standing instructions so `task:` only carries the variable content specific to this task.

## When to Use

```
Have implementation plan?
├── no  → brainstorm first, then writing-plans
└── yes
    Tasks mostly independent?
    ├── no (tightly coupled) → execute manually
    └── yes → subagent-driven-development  ← you are here
               (open a new pi session if you want a clean context window)
```

## The Process

### Before Starting
**Required:** Set up an isolated git worktree using the `using-git-worktrees` skill. Never implement on main/master.

### Step 1: Load the plan
Read the plan file once. Extract all tasks with their full text. Note the working directory (worktree path). Create a TodoWrite list.

### Step 2: Per-task loop

```
For each task:
  1. Dispatch implementer subagent
     → If implementer asks questions: answer them, re-dispatch
     → Implementer implements, runs TDD, commits, self-reviews, reports back

  2. Dispatch spec-reviewer subagent
     → ✅ compliant: proceed to step 3
     → ❌ issues: dispatch implementer with fix list, re-run spec review
        Repeat until ✅

  3. Dispatch code-quality-reviewer subagent (only after spec ✅)
     → ✅ approved: proceed to step 4
     → ❌ request changes: dispatch implementer with fix list, re-run quality review
        Repeat until ✅

  4. Dispatch security-reviewer subagent (only after quality ✅)
     → ✅ pass: mark task complete in TodoWrite
     → ❌ issues: dispatch implementer with fix list, re-run security review
        Repeat until ✅

  5. Mark task complete in TodoWrite
```

### Step 3: Final review
After all tasks complete, dispatch `reviewer` agent for a final pass over the entire implementation.

## Prompt Templates

See these files for the exact `subagent()` call syntax for each role:

- `./implementer-prompt.md` — how to dispatch the implementer
- `./spec-reviewer-prompt.md` — how to dispatch the spec reviewer (and handle ❌)
- `./code-quality-reviewer-prompt.md` — how to dispatch the quality reviewer (and handle ❌)

## Example Workflow

```
[Read plan: docs/plans/feature-plan.md]
[Extract all 3 tasks with full text and context]
[Create TodoWrite: Task 1, Task 2, Task 3]

─── Task 1: Hook installation script ───

subagent(agent: "implementer", task: "Task 1: Hook installation script\n\n[full task text]\n\n[context]", cwd: ".worktrees/feature")

→ Implementer: "Before I begin — should the hook be installed at user or system level?"
→ You: "User level (~/.config/hooks/)"
→ Re-dispatch with answer

→ Implementer reports:
    Completed: install-hook command with --force flag
    Tests: 5/5 passing
    Commit: a1b2c3d

subagent(agent: "spec-reviewer", task: "Review Task 1\n\n[requirements]\n\n[implementer report]\n\nCommit: a1b2c3d", cwd: ".worktrees/feature")

→ Spec reviewer: ✅ Spec compliant

subagent(agent: "code-quality-reviewer", task: "Review Task 1\n\n[report]\n\nBase: a0b1c2d  Head: a1b2c3d", cwd: ".worktrees/feature")

→ Quality reviewer: ✅ Approved

[Mark Task 1 complete]

─── Task 2: Recovery modes ───

subagent(agent: "implementer", task: "Task 2: Recovery modes\n\n[full task text]\n\n[context]", cwd: ".worktrees/feature")

→ Implementer reports:
    Completed: verify/repair modes
    Tests: 8/8 passing
    Commit: b2c3d4e

subagent(agent: "spec-reviewer", task: "Review Task 2\n\n[requirements]\n\n[implementer report]\n\nCommit: b2c3d4e", cwd: ".worktrees/feature")

→ Spec reviewer: ❌ Issues found
    Missing: progress reporting (spec: "report every 100 items")
    Extra: --json flag (not in spec)

subagent(agent: "implementer", task: "Fix spec issues in Task 2\n\n[issues list]", cwd: ".worktrees/feature")

→ Implementer: removed --json, added progress reporting. Commit: c3d4e5f

subagent(agent: "spec-reviewer", task: "Re-review Task 2\n\n[requirements]\n\n[updated report]\n\nCommit: c3d4e5f", cwd: ".worktrees/feature")

→ Spec reviewer: ✅ Spec compliant

subagent(agent: "code-quality-reviewer", task: "Review Task 2\n\nBase: b1c2d3e  Head: c3d4e5f", cwd: ".worktrees/feature")

→ Quality reviewer:
    Important ⚠️: magic number 100 — extract to PROGRESS_INTERVAL constant

subagent(agent: "implementer", task: "Fix quality issue in Task 2\n\nExtract magic number 100 to named constant PROGRESS_INTERVAL", cwd: ".worktrees/feature")

→ Implementer: extracted constant. Commit: d4e5f6g

subagent(agent: "code-quality-reviewer", task: "Re-review Task 2\n\nBase: b1c2d3e  Head: d4e5f6g", cwd: ".worktrees/feature")

→ Quality reviewer: ✅ Approved

[Mark Task 2 complete]

... [Task 3 same pattern] ...

[All tasks complete]
subagent(agent: "reviewer", task: "Final review of entire feature implementation\n\n[summary of all changes]", cwd: ".worktrees/feature")
```

## Red Flags

**Never:**
- Implement on main/master without explicit user consent
- Skip spec compliance review
- Skip code quality review
- Skip security review
- Start quality review before spec compliance is ✅
- Start security review before quality is ✅
- Move to the next task while any review has open issues
- Make the subagent read the plan file — provide the full task text directly
- Skip scene-setting context — subagent needs to know where the task fits
- Ignore subagent questions — answer them before proceeding
- Accept "close enough" from either reviewer

**If the implementer asks questions:**
- Answer clearly and completely
- Re-dispatch with answers included

**If a reviewer finds issues:**
- Dispatch the implementer with the specific issue list
- Re-dispatch the same reviewer after the fix
- Do not skip the re-review

**If a subagent fails completely:**
- Dispatch a fresh implementer with specific repair instructions
- Do not attempt manual fixes (context pollution)

## Integration

**Required before starting:**
- `using-git-worktrees` — set up isolated workspace first

**Plan comes from:**
- `writing-plans` — creates the plan this skill executes

**Fresh context window:** Open a new pi session and load this skill. No separate skill needed.

**TDD:** Enforced by the `implementer` agent's system prompt — always writes failing tests first.
