# Progress Tracking + Package Rename Implementation Plan

> **For Claude:** Implement this plan task-by-task using `subagent-driven-development` — fresh subagent per task with three-gate review (spec → quality → security). Load the skill and begin.

**Goal:** Add durable progress tracking for long-running features and rename the package from `agentic-dev-workflow` to `forge`.

**Architecture:** Two independent concerns. Progress tracking adds a `PROGRESS.md` file written by the implementer after each commit — no new infrastructure, just a file and two prompt changes. The rename touches `package.json`, `README.md`, install instructions, and the GitHub repo itself.

**Tech Stack:** Markdown, JSON (package.json), shell (git)

**Research basis:** `docs/research/2026-02-23-workflow-evaluation.md` — sources [1] (Anthropic) and [2] (Clouâtre) directly inform the progress tracking design.

---

## Task 1: Add PROGRESS.md tracking to the implementer agent

**Files:**
- Modify: `extensions/subagent/agents/implementer.md`

**What to change:**

Find the section in `implementer.md` that describes the commit step and self-review reporting. After the commit step, add an instruction to append task status to `docs/plans/PROGRESS.md`.

**Step 1: Read the current implementer prompt**

```bash
cat extensions/subagent/agents/implementer.md
```

Find the section that says something like "After committing, report back" or the output/reporting section.

**Step 2: Add the progress file instruction**

In the commit/reporting section, add — after the commit step, before or as part of the reporting step:

```markdown
**After committing:** Append your task status to `docs/plans/PROGRESS.md` in the worktree root (create the file if it doesn't exist). Use this format:

```markdown
### Task N: [Task Name]
- **Status:** ✅ Complete
- **Commit:** <SHA>
- **Built:** [one sentence — what was implemented]
- **Tests:** [X passing]
- **Notes:** [anything the next task or a future session needs to know — schema changes, edge cases found, deferred work]
- **Timestamp:** [ISO date]
```

If the task failed all review gates and was abandoned, mark it:
```markdown
### Task N: [Task Name]
- **Status:** ❌ Abandoned
- **Reason:** [why]
- **Last commit:** <SHA or "none">
```
```

**Step 3: Verify the addition reads naturally in context**

Re-read the full implementer.md after the edit. The progress file instruction should sit between "commit" and "report back to orchestrator" — it's part of wrapping up the task, not an afterthought.

**Step 4: Commit**

```bash
git add extensions/subagent/agents/implementer.md
git commit -m "feat: implementer writes task status to PROGRESS.md after each commit"
```

---

## Task 2: Add resume protocol to subagent-driven-development skill

**Files:**
- Modify: `skills/subagent-driven-development/SKILL.md`

**What to change:**

Add a "Resuming a feature" section and update the "Before Starting" section to include the PROGRESS.md check.

**Step 1: Read the current skill**

```bash
cat skills/subagent-driven-development/SKILL.md
```

Find "### Before Starting" and "### Step 1: Load the plan".

**Step 2: Update "Before Starting"**

Replace the current "Before Starting" content with:

```markdown
### Before Starting

**Required:** Set up an isolated git worktree using the `using-git-worktrees` skill. Never implement on main/master.

**Resuming mid-feature?** Run this boot sequence first:

```bash
# 1. Check progress state
cat docs/plans/PROGRESS.md 2>/dev/null || echo "No progress file — starting fresh"

# 2. Check recent commits
git log --oneline -10

# 3. Confirm working directory
pwd

# 4. Verify baseline is clean
pnpm test   # or npm test / pytest — detect from project
```

Then read the plan file and pick up at the **first task not marked ✅ Complete** in PROGRESS.md. Tasks not in PROGRESS.md at all = not started.
```

**Step 3: Add a "Resuming a Feature" section**

After the "## The Process" section, add:

```markdown
## Resuming a Feature

When opening a new session to continue an in-progress feature:

1. **Read `docs/plans/PROGRESS.md`** — identifies completed tasks, last commit SHA, and any notes from previous implementers
2. **Read `git log --oneline -10`** — confirms what was committed and when
3. **Run baseline tests** — verify nothing is broken before dispatching
4. **Identify resume point** — first task in the plan not marked ✅ in PROGRESS.md
5. **Dispatch implementer for that task** — include relevant notes from PROGRESS.md as context

If PROGRESS.md doesn't exist but git log shows commits, the feature was started before this tracking was added. Use git log + the plan file to reconstruct state manually, then create PROGRESS.md with the tasks that appear to be done.
```

**Step 4: Commit**

```bash
git add skills/subagent-driven-development/SKILL.md
git commit -m "feat: add resume protocol and PROGRESS.md boot sequence to subagent-driven-development"
```

---

## Task 3: Update the implementer-prompt template

**Files:**
- Modify: `skills/subagent-driven-development/implementer-prompt.md`

**What to change:**

The implementer-prompt.md shows the exact `subagent()` call syntax for dispatching the implementer. The task text template needs to include a reminder about PROGRESS.md so orchestrators building task strings include it.

**Step 1: Read the current template**

```bash
cat skills/subagent-driven-development/implementer-prompt.md
```

**Step 2: Add PROGRESS.md to the task string template**

In the example task string, after the context section, add:

```
## Progress File
Update `docs/plans/PROGRESS.md` after committing with your task status, commit SHA, what was built, and any notes for subsequent tasks.
```

This ensures every orchestrator-built task string includes the reminder, not just the implementer's standing instructions.

**Step 3: Commit**

```bash
git add skills/subagent-driven-development/implementer-prompt.md
git commit -m "feat: add PROGRESS.md reminder to implementer dispatch template"
```

---

## Task 4: Rename package from agentic-dev-workflow to forge

**Files:**
- Modify: `package.json`
- Modify: `README.md`
- Modify: `WORKFLOW.md`
- Check: any other files with the old name

**Step 1: Search for all references to the old name**

```bash
grep -r "agentic-dev-workflow" . --include="*.md" --include="*.json" --include="*.ts" -l
```

**Step 2: Update package.json**

Change:
```json
{
  "name": "agentic-dev-workflow",
  "description": "A state-of-the-art agentic development workflow for pi..."
}
```

To:
```json
{
  "name": "forge",
  "description": "A deliberate agentic development workflow for pi — multi-agent execution, three-gate review, and full lifecycle from research to ship."
}
```

**Step 3: Update README.md install command**

Change:
```bash
pi install git:github.com/josorio7122/agentic-dev-workflow
```

To:
```bash
pi install git:github.com/josorio7122/forge
```

Also update the title and any other references to the old name.

**Step 4: Update WORKFLOW.md**

Search for any references to `agentic-dev-workflow` in WORKFLOW.md and update to `forge`.

**Step 5: Commit**

```bash
git add package.json README.md WORKFLOW.md
git commit -m "chore: rename package from agentic-dev-workflow to forge"
```

---

## Task 5: Update AGENTS.md global config for new package name

**Files:**
- Modify: `/Users/josorio/.pi/agent/AGENTS.md`

**What to change:**

AGENTS.md references the workflow package by its git path. After the GitHub repo is renamed, the path changes. But also, the install reference in AGENTS.md (if any) should reflect `forge`.

**Step 1: Read current AGENTS.md**

```bash
cat /Users/josorio/.pi/agent/AGENTS.md
```

Find any references to `agentic-dev-workflow` — in the git path (`~/.pi/agent/git/github.com/josorio7122/agentic-dev-workflow/`) or install instructions.

**Step 2: Update all references**

Replace all occurrences of `josorio7122/agentic-dev-workflow` with `josorio7122/forge` and all occurrences of `agentic-dev-workflow/` path segments with `forge/`.

**Step 3: Commit**

```bash
cd /Users/josorio/.pi/agent
git add AGENTS.md
git commit -m "chore: update AGENTS.md to reference forge (renamed from agentic-dev-workflow)"
```

Note: `/Users/josorio/.pi/agent/AGENTS.md` may be in a different git repo from the package itself. Run this commit in the correct repo.

---

## Task 6: Rename the GitHub repository

**This is a manual step — cannot be done via git CLI.**

1. Go to https://github.com/josorio7122/agentic-dev-workflow
2. Settings → General → Repository name → change to `forge`
3. GitHub will set up a redirect from the old name automatically (but update all local remotes)

**After renaming, update local git remote:**

```bash
cd /Users/josorio/.pi/agent/git/github.com/josorio7122/agentic-dev-workflow
git remote set-url origin git@github.com:josorio7122/forge.git
```

**Move the local directory to match:**

```bash
mv /Users/josorio/.pi/agent/git/github.com/josorio7122/agentic-dev-workflow \
   /Users/josorio/.pi/agent/git/github.com/josorio7122/forge
```

**Update the symlink in pi's skill/agent paths if needed** — pi resolves skill paths at load time, so if the directory moves, check whether pi's config references the absolute path.

---

## Task 7: Update README.md to reflect the new features

**Files:**
- Modify: `README.md`

**What to change:**

The README currently mentions "2 extensions — workflow phase status bar, PR review widget" — but workflow-status was removed. Also, the "The Workflow Status Bar" section in the README describes a feature that no longer exists. These should be cleaned up as part of the rename.

**Step 1: Read README.md**

```bash
cat README.md
```

**Step 2: Fix the extensions count and remove the status bar section**

- Change "2 extensions" to "1 extension" in the What's Included section
- Remove the "## The Workflow Status Bar" section entirely (describes workflow-status.ts which was removed)
- Remove any footer/status-bar UI screenshots or descriptions

**Step 3: Add a brief mention of PROGRESS.md**

In the "Execute" step of the walking-through-a-real-feature section, add a line:

> *After each task completes, the implementer appends its status to `docs/plans/PROGRESS.md` — so if you close the session and come back tomorrow, the next session reads that file first and resumes exactly where you left off.*

**Step 4: Commit**

```bash
git add README.md
git commit -m "docs: fix extension count, remove status bar section, document PROGRESS.md"
```

---

## Execution Notes

- Tasks 1, 2, 3 are independent — can be dispatched in parallel
- Task 4 depends on nothing but should run after 1-3 (cleaner commit history)
- Task 5 depends on Task 4 (needs new name confirmed)
- Task 6 is manual (GitHub UI) — do it after all code changes are committed and pushed
- Task 7 can run after Task 4

**Worktree:** All code changes happen in the `agentic-dev-workflow` repo itself. No worktree needed — this IS the worktree.

**Tests:** No automated tests in this package. Verification is manual: read the modified files and confirm the changes make sense in context.
