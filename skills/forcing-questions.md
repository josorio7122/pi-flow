---
name: forcing-questions
description: Ask structured forcing questions before starting implementation work to eliminate ambiguity and prevent wasted effort.
trigger: before implementation
---

### Before starting any implementation

Ask up to 5 forcing questions — **one at a time**, not batched.
Each answer informs whether the next question is still needed.
Skip questions whose answers are already obvious from context.

1. **Goal**: "What observable state must be TRUE when this is done?"
2. **Success metric**: "How will you know this worked? What test or user action proves it?"
3. **Constraints**: "What existing behavior must NOT change?"
4. **Out of scope**: "What is the closest related thing you do NOT want built?"
5. **Blast radius**: "Who is affected if this breaks?"

If the request is simple and unambiguous (typo fix, config change, single-file edit),
skip the questions entirely and proceed.

Do not dispatch agents until the goal is clear.
