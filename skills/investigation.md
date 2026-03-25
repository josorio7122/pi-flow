---
name: investigation
description: Systematic debugging protocol with root-cause-first analysis and 3-strike escalation. Use when encountering failures, unexpected behavior, or flaky tests.
---

### Investigation protocol

When something fails or behaves unexpectedly:

1. **Read the full error.** Full stack trace, full log output.
   Do not guess. Do not try a fix without understanding the cause.

2. **State the root cause** before writing any fix:
   "Root cause: [X], because [evidence]."

3. **Fix the root cause** — not the symptom.

4. **Verify** — run the failing test or command again. Confirm it passes.

**3-strike rule:** If 3 distinct approaches all failed, STOP and escalate:

```
## Escalation: [what failed]
1. Tried: [approach 1] → Failed because: [reason]
2. Tried: [approach 2] → Failed because: [reason]
3. Tried: [approach 3] → Failed because: [reason]
Hypothesis: [what you think is actually wrong]
Need: [what information or decision is required]
```

Do not try a fourth approach. Present the escalation in your output.
(If you are a sub-agent, this escalates to the coordinator. If you are
the coordinator, this escalates to the user.)

**Scope lock:** Restrict changes to the affected files.
Do not refactor adjacent code during a debugging session.
