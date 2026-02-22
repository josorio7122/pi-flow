# Code Quality Reviewer Dispatch Template

Use this after spec compliance is `✅`. Dispatch via the `subagent` tool.

**Never dispatch this before spec compliance passes.**

## Tool Call

```
subagent(
  agent: "code-quality-reviewer",
  task: """
    Review code quality for Task N: [task name]

    ## What Was Implemented

    [Paste the implementer's report — what they built, files changed]

    ## Task Requirements

    [Full task text for context]

    ## Commits to Review

    Base SHA (before task): [git SHA]
    Head SHA (after task):  [git SHA]

    ## Working Directory

    [Absolute path to worktree]
  """,
  cwd: "[absolute path to worktree]"
)
```

## Getting the SHAs

```bash
git log --oneline -5   # find the commit(s) for this task
```

- **Base SHA**: the commit before the implementer started this task
- **Head SHA**: the implementer's final commit for this task

## Interpreting the result

**If `✅ Approved` or `✅ Approved with minor fixes`:**
- If minor fixes are listed, dispatch implementer with the fix list
- Then mark task complete in TodoWrite

**If `❌ Request changes`:** Dispatch the implementer with the specific issues:

```
subagent(
  agent: "implementer",
  task: """
    Fix code quality issues in Task N: [task name]

    The code quality reviewer found the following issues:

    [Paste the Critical 🚨 and Important ⚠️ sections]

    ## Working Directory

    [Absolute path to worktree]
  """,
  cwd: "[absolute path to worktree]"
)
```

Then re-run code quality review. Repeat until `✅`.

**Only mark the task complete after `✅` from both spec-reviewer AND code-quality-reviewer.**
