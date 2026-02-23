---
name: ship
description: Cleans up a completed feature branch — reviews commits, squashes if needed, pushes, opens a PR, and removes the worktree. Use after all tasks in a feature are implemented and reviewed.
compatibility: Requires gh CLI authenticated. Run: gh auth status
metadata:
  author: josorio7122
  version: "1.0"
---

# Ship

Wrap up a completed feature branch: clean commit history, push, open PR, remove worktree.

**Announce at start:** "I'm using the ship skill to wrap up this branch."

## When to Use

After `execute` completes all tasks and the final `branch-reviewer` agent has approved. The worktree exists, all commits are on the feature branch, and you're ready to ship.

## Process

### Step 1: Verify clean state

```bash
git status
git log main..HEAD --oneline
```

Confirm:
- No uncommitted changes
- All expected commits are present
- Tests still pass: run the project test command (`npm test`, `pytest`, etc.)

If tests fail — stop. Do not proceed. Fix or dispatch `debugger`.

### Step 2: Review commit history

```bash
git log main..HEAD --oneline
```

Assess the commits:
- **Clean history** (logical commits, good messages) → proceed to Step 3 as-is
- **Messy history** (WIP commits, "fix fix fix", temp commits) → squash in Step 2a

#### Step 2a: Squash if needed

Count commits since main:
```bash
git log main..HEAD --oneline | wc -l
```

Interactive rebase to squash:
```bash
git rebase -i main
```

In the editor: keep the first commit as `pick`, mark the rest as `squash` or `fixup`. Write a clean commit message following the convention:
```
type: short description

- bullet of what changed
- bullet of what changed
```

Verify after rebase:
```bash
git log main..HEAD --oneline
git status
```

### Step 3: Push branch

```bash
git push -u origin HEAD
```

If the branch already exists remotely and history was rewritten (squash):
```bash
git push --force-with-lease origin HEAD
```

### Step 4: Open PR

```bash
gh pr create --title "<type>: <description>" --body "<body>" --base main
```

PR body should include:
- **What**: one paragraph describing what this implements
- **Why**: the problem it solves or feature it adds
- **How**: key design decisions made
- **Testing**: how it was tested (TDD, test suite, manual)
- **Checklist**: `- [x] Tests pass`, `- [x] No secrets committed`, `- [x] Docs updated`

Print the PR URL after creation.

### Step 5: Remove worktree

```bash
# From the main repo (not from inside the worktree)
cd <main-repo-root>
git worktree remove <worktree-path>
```

If the worktree has uncommitted changes (shouldn't at this point):
```bash
git worktree remove --force <worktree-path>
```

Verify:
```bash
git worktree list
```

### Step 6: Report

```
Branch: <branch-name>
PR: <url>
Commits: <N> commit(s) on branch
Worktree: removed (<path>)

Ready for review.
```

## Quick Reference

| Situation | Action |
|---|---|
| Tests fail before push | Stop — fix or dispatch debugger |
| Clean commit history | Skip squash, push directly |
| Messy commit history | Rebase -i main, squash, then push |
| Branch already pushed | Use `--force-with-lease` after squash |
| No `gh` CLI | Provide the push URL, let user open PR manually |
| Worktree is the current directory | `cd` to repo root first, then remove |

## Red Flags

**Never:**
- Push with failing tests
- Force push to `main` or `master`
- Remove worktree before pushing
- Skip the PR — always open one, even for small changes

## Integration

**Called after:**
- `execute` — all tasks complete, final review passed

**Pairs with:**
- `worktree` — this skill is the cleanup counterpart to worktree setup
