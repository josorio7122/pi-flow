# SDD Anti-Patterns

> Common mistakes that make specs non-compliant. For each anti-pattern: what it looks like, why it fails, and how to fix it. The `sdd-spec` skill checks for all of these during the compliance pass.

---

## Anti-Pattern 1: Specification Theater

**What it looks like:**
Spec documents that are written but never validated against implementation. Acceptance criteria that no one ever checks. A `CONSTITUTION.md` that developers don't read when building endpoints.

**Why it fails:**
A spec no one uses isn't a spec — it's documentation debt. SDD requires that the spec is the primary source of truth, consulted at every implementation decision.

**How to fix:**
- Acceptance criteria must be runnable as integration tests
- Every spec file must be referenced in README.md with usage guidance ("include this file when asking an LLM about X")
- The spec must include a maintenance section: when to update it (before or alongside code changes, never after)

---

## Anti-Pattern 2: Implementation Bleeding

**What it looks like:**
```
❌ "The spans are stored in a PostgreSQL table with an index on trace_id."
❌ "The API is implemented in FastAPI."
❌ "The left panel shows the span tree; the right panel shows span details."
❌ "Use a Redis cache for the session token."
❌ "The dropdown pre-populates from the /v1/datasets endpoint."
```

**Why it fails:**
Specs that prescribe implementation lose their value as behavioral contracts. They lock implementors into choices the spec author made arbitrarily, and they become wrong the moment the implementation diverges.

**How to fix:**
Replace every implementation detail with its behavioral consequence:
```
✅ "A span belongs to exactly one trace, identified by trace_id."
✅ "The platform accepts HTTP requests with JSON bodies."
✅ "A developer can view all spans in a trace and inspect each one's details."
✅ "Sessions are authenticated via bearer token (CONSTITUTION.md)."
✅ "The user can select a dataset from the list of datasets in the project."
```

The test: can two different teams implement the spec correctly using completely different technology stacks? If yes, the spec is implementation-free.

---

## Anti-Pattern 3: Premature Comprehensiveness

**What it looks like:**
- A data model with 40 fields per entity on the first draft
- Acceptance criteria covering every possible input combination
- An "out of scope" section that is empty
- Spec chapters for features the team hasn't decided to build

**Why it fails:**
AI-generated spec bloat: accepting verbose AI output without human curation. If you're skimming sections thinking "AI probably got it right," the spec is too large. Bloated specs are not read; unread specs are not maintained; unmaintained specs drift from reality.

**How to fix:**
- Apply YAGNI ruthlessly: every field, endpoint, and acceptance criterion must justify its inclusion
- The "Out of Scope for v1" section is mandatory — be explicit about what you're NOT building
- Start with the minimum field set; add fields when a user story requires them
- Acceptance criteria: 5–8 per subsystem is better than 20+

---

## Anti-Pattern 4: Vague User Stories

**What it looks like:**
```
❌ "As a user, I want the system to work well."
❌ "As a developer, I want to see traces."
❌ "As a user, I want fast performance."
```

**Why it fails:**
User stories without a specific action and a benefit are not testable. They don't tell an implementor what to build or an AI what to generate.

**How to fix:**
```
✅ "As a developer, I can submit spans out of order and the platform assembles them into the correct tree."
✅ "As a developer, I can filter traces by time range and metadata to find examples of a specific failure mode."
✅ "As a reviewer, I can see the application's input and output in plain text without reading JSON."
```

The test: given only the user story and the data model, could an engineer implement the feature without asking any clarifying questions? If no, the story is too vague.

---

## Anti-Pattern 5: Untestable Acceptance Criteria

**What it looks like:**
```
❌ GIVEN a trace exists
WHEN it is displayed
THEN the trace looks good

❌ GIVEN a span is submitted
WHEN the user views the trace
THEN they can understand the execution
```

**Why it fails:**
Criteria that can't be verified objectively are not criteria — they're hopes. They cannot be used to write integration tests, cannot guide an AI agent's implementation, and cannot be used to detect regressions.

**How to fix:**
Every GIVEN/WHEN/THEN must be:
- **Specific**: exact field names, exact error codes, exact counts
- **Observable**: the THEN must be something you can check in an HTTP response or UI state
- **Stateless**: the scenario sets up its own preconditions in GIVEN

```
✅ GIVEN a span submitted with a valid trace_id and no parent_span_id
WHEN the trace is fetched via GET /v1/traces/:id
THEN the response has root_span_id set to that span's id

✅ GIVEN a span missing the required field "name"
WHEN it is submitted via POST /v1/spans
THEN the response status is 400
AND the error code is INVALID_SPAN
AND the details object identifies "name" as the missing field
```

---

## Anti-Pattern 6: Missing Ubiquitous Language

**What it looks like:**
- Using "run" to mean both "an experiment run (ExperimentRun entity)" and "to run an experiment (verb)"
- Using "evaluation", "eval", and "experiment" interchangeably
- Defining terms in prose but not in a glossary
- Using technical terms (span, trace, token) without defining them for non-technical readers

**Why it fails:**
Ambiguous language causes divergent implementations. When two developers read "a run" and mean different things, they build different systems. When a PM reads the spec and doesn't know what "annotation" means, they can't validate it.

**How to fix:**
- Every domain term gets one canonical name in GLOSSARY.md
- Use that name consistently everywhere — no synonyms, no abbreviations that aren't in the glossary
- If you catch yourself writing two names for the same concept, pick one and update the glossary

---

## Anti-Pattern 7: Orphaned Error Codes

**What it looks like:**
An endpoint spec that returns `INVALID_SPAN_PARENT` but that code appears in no global error table.

**Why it fails:**
Implementors don't know what HTTP status to return. Clients don't know how to handle the error. LLM agents generating code from the spec will invent a status code.

**How to fix:**
Every error code used in any spec file must be defined in exactly one of:
- `CONSTITUTION.md` — for errors that can appear across multiple subsystems
- `specs/06-api.md` — for errors specific to one endpoint

The definition must include: the code name, the HTTP status, and the condition that triggers it.

---

## Anti-Pattern 8: Spec-Implementation Drift

**What it looks like:**
The spec says `GET /v1/experiments/:id/summary` returns a `mean_score` field. The implementation returns `average_score`. The spec says scores are in `[0.0, 1.0]`. The implementation accepts `[0, 100]`.

**Why it fails:**
Once the spec and implementation diverge, the spec stops being the source of truth. Future developers implement against the code, not the spec. The spec becomes legacy documentation.

**How to fix:**
- Treat spec changes like API changes: they require deliberate decisions, not casual edits
- In the README, state explicitly: "Update the spec before or alongside code changes, never after."
- The spec is committed to version control in the same repo as the code (or in a dedicated spec repo with tight coupling to the code repo via CI)
- CI checks that can detect drift (schema validation, contract tests) should be set up as the first implementation task

---

## Anti-Pattern 9: Missing Cross-Feature Flow

**What it looks like:**
Each subsystem spec is complete in isolation, but there is no document explaining how they connect. An engineer reading only the annotation spec doesn't know it feeds into datasets. An LLM asked to implement the review queue doesn't know it affects experiment coverage.

**Why it fails:**
Systems thinking is required for correct implementation. Features that touch multiple subsystems will be implemented inconsistently if each subsystem is specified in isolation.

**How to fix:**
`specs/00-overview.md` is mandatory, not optional. It must:
- Name every workflow and describe it as a complete narrative
- Show every cross-subsystem data flow in a diagram
- List every spec file and what workflow it serves

---

## Anti-Pattern 10: No Out-of-Scope Declaration

**What it looks like:**
A spec with no section declaring what is explicitly not included. Every feature request gets added to the spec because "nothing says we shouldn't."

**Why it fails:**
Without explicit scope boundaries, scope creep is invisible. Teams build features that weren't intended. LLM agents generating implementations include features that weren't specced. Integrators expect capabilities the platform doesn't have.

**How to fix:**
`CONSTITUTION.md` must have an "Out of Scope for v1" section that:
- Lists specific features by name
- States *why* each is out of scope (complex, separable, future version, etc.)
- Is updated whenever a new "definitely not" decision is made

The existence of this section is itself a compliance requirement.
