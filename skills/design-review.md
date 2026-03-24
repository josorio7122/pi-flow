---
name: design-review
description: Present design options with trade-offs after codebase analysis and before dispatching the planner. Ensures the user approves the approach before implementation begins.
trigger: after scout analysis, before planner
---

### Design review — before dispatching planner

After scouts return analysis, present a design to the user:

1. **Constraint inventory** — list what cannot change:
   - Existing API contracts, DB schema, external dependencies
   - Project conventions from AGENTS.md
   - Performance budgets, security requirements

2. **Precedent search** — how was a similar problem solved in this codebase?
   Use the same pattern unless there is a specific reason not to (state the reason).

3. **Options** — present 2-3 approaches. For each:
   - **How**: one paragraph explaining the approach
   - **Pros**: concrete advantages (cite codebase evidence)
   - **Cons**: concrete costs — never omit the cost column
   - **Complexity**: low / medium / high
   - **Scope**: estimated file count + list key files

4. **Recommendation** — state which option and why. Be decisive.
   If two options are genuinely equivalent, explain the tie-breaking criterion.

5. **Wait for approval** — do not dispatch planner until the user approves.

If the change is trivial (single file, obvious approach), skip the full
options format. State what you plan to do and ask: "Sound good?"
