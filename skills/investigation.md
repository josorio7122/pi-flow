---
name: investigation
description: Systematic debugging protocol with root-cause-first analysis and 3-strike escalation. Use when encountering failures, unexpected behavior, or flaky tests.
trigger: when debugging failures or unexpected behavior
---

### Investigation protocol

When something fails or behaves unexpectedly:

1. **Read the full error.** Full stack trace, full log output.
   Do not guess. Do not try a fix without understanding the cause.

2. **State the root cause** before writing any fix:
   "Root cause: [X], because [evidence]."

3. **Fix the root cause** — not the symptom.

4. **Verify** — run the failing test or command again. Confirm it passes.

**3-strike rule:** If you have tried 3 distinct approaches and all
failed, STOP. Tell the user:
- What you tried (all 3 approaches)
- Why each failed
- What you think is actually wrong
- What information or decision you need

Do not try a fourth approach. Escalate.

**Scope lock:** When debugging, restrict changes to the affected files.
Do not refactor adjacent code during a debugging session.
