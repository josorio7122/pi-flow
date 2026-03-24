---
name: memory
description: Persist learnings across features. Write decisions, patterns, and lessons to .flow/memory/ so agents read them automatically on future dispatches.
---

### Cross-feature memory

Write learnings to `.flow/memory/` at these moments:
- After the user approves a design → write the decision
- After scouts discover a codebase pattern → write the pattern
- After a 3-strike debugging session → write the lesson
- After shipping a feature → write all three

**Files and formats:**

**`.flow/memory/decisions.md`** — architectural decisions.
Append with `## <feature> — <date>` heading. Include: what was decided,
what alternatives were rejected, why.

**`.flow/memory/patterns.md`** — codebase patterns.
Append with `## <pattern-name>` heading. Include: where the pattern is
used, which files, how to follow it.

**`.flow/memory/lessons.md`** — mistakes and debugging insights.
Append with `## <lesson> — <date>` heading. Include: what went wrong,
root cause, how it was resolved.

Agents read these files automatically via injected variables.
Write once, every future dispatch benefits.

Do not write trivial or obvious things. Memory should contain insights
that would save time on the next feature.
