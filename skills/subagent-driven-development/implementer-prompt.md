# Implementer Dispatch Template

Use this when dispatching an implementer subagent via the `subagent` tool.

## Tool Call

```
subagent(
  agent: "implementer",
  task: """
    Task N: [task name]

    ## Task Description

    [FULL TEXT of the task from the plan — paste it here verbatim, do not ask the subagent to read the file]

    ## Context

    [Scene-setting: what branch/worktree we're in, what was completed before this task,
     key architectural decisions, dependencies this task relies on, anything the implementer
     needs to understand where this fits in the larger picture]

    ## Progress File

    After committing, update `docs/plans/PROGRESS.md` with your task status, commit SHA,
    what was built, and any notes for subsequent tasks or future sessions.

    ## Working Directory

    [Absolute path to the worktree or project root]
  """,
  cwd: "[absolute path to worktree]"
)
```

## What the implementer will do

The `implementer` agent:
1. Reads the task, asks clarifying questions if needed
2. Follows TDD — writes failing test first, implements, confirms passing
3. Commits the work
4. Writes task status to `docs/plans/PROGRESS.md`
5. Self-reviews and fixes any issues found
6. Reports back with what was done, tests, files changed, commit SHA

## If the implementer asks questions

Answer clearly and completely before they proceed. Do not rush them. Their questions surface ambiguity that would otherwise cause rework.

## If the implementer reports issues in self-review

That's good — it means the self-review worked. The same subagent invocation handled it. The report will note what was found and fixed.
