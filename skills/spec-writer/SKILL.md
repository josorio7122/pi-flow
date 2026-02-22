---
name: spec-writer
description: "Write a complete Spec-Driven Development (SDD) spec for a software platform. Produces all required artifacts in dependency order through structured interviews, templates, and compliance checks. Use when a user asks to create, design, or write a spec for a platform, service, or product. Produces: GLOSSARY.md, CONSTITUTION.md, DATA-MODEL.md, specs/00-overview.md, per-subsystem specs, HTTP API contract, and UI behavioral spec."
---

# Spec Writer

**Announce at start:** "I'm using the spec-writer skill to produce a complete SDD spec."

Load all reference documents before starting:
- [references/PHASES.md](references/PHASES.md) — interview questions and per-artifact requirements
- [references/COMPLIANCE-CHECKLIST.md](references/COMPLIANCE-CHECKLIST.md) — pass/fail gates between phases
- [references/SPEC-TEMPLATES.md](references/SPEC-TEMPLATES.md) — canonical templates for every artifact
- [references/ANTI-PATTERNS.md](references/ANTI-PATTERNS.md) — what to detect and fix during compliance passes

---

## Output

Eight artifacts, in this order:

| # | File | What it is |
|---|---|---|
| 1 | `GLOSSARY.md` | Plain-English definitions for every domain term |
| 2 | `CONSTITUTION.md` | Cross-cutting rules: auth, errors, pagination, timestamps, IDs, out-of-scope |
| 3 | `DATA-MODEL.md` | Every entity — field tables, constraints, relationships |
| 4 | `specs/00-overview.md` | End-to-end workflows + data flow diagram |
| 5–N | `specs/NN-[name].md` | One per subsystem: user stories, behavior, acceptance criteria, edge cases |
| N+1 | `specs/06-api.md` | HTTP API contract: every endpoint, request/response, error codes |
| N+2 | `specs/07-ui.md` | UI behavioral spec: what users can do, rendering contract |
| N+3 | `README.md` | Reading order, LLM usage guide, maintenance policy |

---

## Process

Five phases. Each phase ends with a compliance check before the next begins. Do not skip or merge phases.

```
Phase 1: Domain Interview  →  Phase 2: Foundation  →  Phase 3: Subsystem Specs
                                                               ↓
                               Phase 5: README + Final Check  ←  Phase 4: API + UI
```

### Phase 1 — Domain Interview

Load [PHASES.md](references/PHASES.md) for the full question sequence (Q1–Q11).

**Rule:** One question per message. Wait for the answer before asking the next.

End the interview with a summary of: platform purpose, user roles, core entities, workflows, out-of-scope list, and confirmed subsystem list. Get user confirmation before writing anything.

### Phase 2 — Foundation

Write in order: GLOSSARY.md → CONSTITUTION.md → DATA-MODEL.md.

After each file:
1. Run the compliance checks from [COMPLIANCE-CHECKLIST.md](references/COMPLIANCE-CHECKLIST.md) for that artifact
2. Print the checklist with ✅ or ❌ per item
3. Fix every ❌ before continuing
4. Show the file to the user and get confirmation
5. Commit

See [PHASES.md](references/PHASES.md) for per-artifact requirements. Use [SPEC-TEMPLATES.md](references/SPEC-TEMPLATES.md) for structure.

### Phase 3 — Overview + Subsystem Specs

Write specs/00-overview.md first (workflows as numbered prose, ASCII data flow diagram, spec file reference table, key design decisions). Then write one `specs/NN-[name].md` per subsystem, in dependency order.

After each file:
1. Run per-subsystem compliance checks
2. Scan for anti-patterns (especially: implementation bleeding, vague user stories, untestable criteria)
3. Fix all findings, show file, confirm, commit

See [PHASES.md](references/PHASES.md) for required sections. See [ANTI-PATTERNS.md](references/ANTI-PATTERNS.md) for what to scan for.

### Phase 4 — API Contract + UI Spec

Write specs/06-api.md (all endpoints, requests, responses, error codes). Then write specs/07-ui.md (behavioral statements only — see the critical rule in [PHASES.md](references/PHASES.md)).

After each file: compliance check → fix → confirm → commit.

Audit after specs/06-api.md: every error code used in any subsystem spec must be defined in CONSTITUTION.md or specs/06-api.md. Add any that are missing.

### Phase 5 — README + Final Pass

Write README.md (see [PHASES.md](references/PHASES.md) for required sections including the LLM usage guide).

Then run the full cross-cutting checks from Section 8 of [COMPLIANCE-CHECKLIST.md](references/COMPLIANCE-CHECKLIST.md). Fix every failure.

Final commit:
```bash
git add -A && git commit -m "spec: complete SDD spec — all compliance checks pass"
```

---

## Compliance Protocol

At every compliance check:
1. Load the relevant section of COMPLIANCE-CHECKLIST.md
2. Check each item explicitly — do not assume
3. Print ✅ or ❌ per item
4. Fix every ❌ immediately, then re-check
5. Only proceed when all items show ✅

If an artifact fails more than 3 checks, rewrite the relevant sections rather than patching line by line.

---

## Stopping Rules

Stop and ask for clarification when:
- An interview answer is ambiguous and would cause divergent decisions in the data model
- A user story implies an entity not yet in DATA-MODEL.md
- Two spec files contradict each other
- An acceptance criterion references behavior not yet specified anywhere

Do not guess. Wrong assumptions in Phase 2 propagate to every subsequent artifact.

---

## Integration

This skill produces the spec. Downstream skills:
- **brainstorming** → design how to implement a specific subsystem
- **writing-plans** → create a task-by-task implementation plan
- **subagent-driven-development** → implement the plan
