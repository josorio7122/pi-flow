# Spec Reviewer Dispatch Template

Use this after the implementer completes a task. Dispatch via the `subagent` tool.

## Tool Call

```
subagent(
  agent: "spec-reviewer",
  task: """
    Review spec compliance for Task N: [task name]

    ## What Was Requested

    [FULL TEXT of the task requirements — same text given to the implementer]

    ## What the Implementer Reported

    [Paste the implementer's full report here]

    ## Commit to Review

    [git SHA of the implementer's commit]

    ## Working Directory

    [Absolute path to worktree]
  """,
  cwd: "[absolute path to worktree]"
)
```

## Interpreting the result

**If `✅ Spec compliant`:** Proceed to code quality review.

**If `❌ Issues found`:** Dispatch the implementer again with the specific issues:

```
subagent(
  agent: "implementer",
  task: """
    Fix spec compliance issues in Task N: [task name]

    The spec reviewer found the following issues:

    [Paste the full ❌ issues list from spec-reviewer output]

    ## Original Task Description

    [Full task text again for reference]

    ## Working Directory

    [Absolute path to worktree]
  """,
  cwd: "[absolute path to worktree]"
)
```

Then re-run spec review. Repeat until `✅`.

**Do not proceed to code quality review until spec compliance is ✅.**
