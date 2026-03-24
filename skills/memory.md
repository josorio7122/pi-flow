---
name: memory
description: Persist learnings across features. Write decisions, patterns, and lessons to .flow/memory/ after completing work. Agents read these automatically on future dispatches.
trigger: after completing a feature, design review, or significant debugging session
---

### Cross-feature memory

After completing significant work, write learnings to `.flow/memory/`:

- **`.flow/memory/decisions.md`** — architectural decisions and their rationale.
  Append with `## <feature> — <date>` heading. Include: what was decided,
  what alternatives were rejected, why.

- **`.flow/memory/patterns.md`** — codebase patterns discovered during scouting.
  Append with `## <pattern-name>` heading. Include: where the pattern is used,
  which files, how to follow it.

- **`.flow/memory/lessons.md`** — mistakes, surprises, and debugging insights.
  Append with `## <lesson> — <date>` heading. Include: what went wrong,
  root cause, how it was resolved.

**When to write memory:**
- After the user approves a design → write the decision
- After scouts discover a codebase pattern → write the pattern
- After a 3-strike debugging session → write the lesson
- After shipping a feature → write all three

**Agents read memory automatically.** Scout, planner, builder, and reviewer
all receive `MEMORY_DECISIONS`, `MEMORY_PATTERNS`, and `MEMORY_LESSONS`
as context. Write once, every future agent benefits.

Do not write trivial or obvious things. Memory should contain insights
that would save time on the next feature.
