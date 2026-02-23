# Phase Details

> Detailed instructions for each phase of the spec skill. Load this file at the start of Phase 1.

---

## Phase 1: Domain Interview — Question Sequence

Ask these questions in order, one per message. Adapt wording naturally, but cover every topic. Wait for the answer before asking the next.

**Q1 — Platform name and one-sentence description:**
"What is the platform called, and what does it do in one sentence?"

**Q2 — Primary users:**
"Who are the primary users? Describe them by role and what they need to accomplish — not by job title."

**Q3 — Core workflow:**
"What is the first thing a user does when they start using the platform, and what is the final outcome they're trying to reach?"

**Q4 — Additional workflows:**
"Are there other distinct workflows — for different roles or different goals?"

**Q5 — Core entities:**
"What are the main things (objects, records, artifacts) that the platform stores or produces? List them by name and one sentence each."
(Don't suggest entity names — let the user define their own vocabulary)

**Q6 — Key behaviors per entity:**
For each entity named in Q5: "What are the most important rules about [entity]? What can change, what can't, what happens when it's deleted?"

**Q7 — Integrations and protocols:**
"Does the platform integrate with any standards, protocols, or external systems? (e.g., OpenTelemetry, OAuth, Webhooks)"

**Q8 — Explicit out-of-scope:**
"What should this spec explicitly NOT include — features you've decided to leave out of v1?"

**Q9 — UI audiences:**
"Does the platform have a user interface? If so, who uses it, and are there different experiences for different roles?"

**Q10 — Constraints:**
"Any hard constraints? (e.g., must be deployable as a single unit, must be implementation-agnostic, must not prescribe a database)"

**Q11 — Subsystem list:**
"Based on what you've told me, I'm seeing these subsystems: [list them]. Does this match what you have in mind? Are any missing or wrong?"

### Summary Before Writing

After Q11, summarize your understanding and confirm with the user before starting Phase 2:
- Platform name and purpose
- User roles and their goals
- Core entities and key rules
- Workflows (step-by-step)
- Out-of-scope items
- Confirmed subsystem list

Do not start Phase 2 until the user confirms the summary.

---

## Phase 2: Foundation — Artifact Requirements

### GLOSSARY.md

- One entry per entity from Q5 + any additional terms used in the spec
- 2–4 plain sentences per definition — no jargon, no implementation details, no database/framework/HTTP references
- "How They Connect" section: prose narrative of the core loop (not a list or table)
- Non-engineer readable throughout

### CONSTITUTION.md

Required sections in order:
1. **Design Principles** — from Q10 constraints + SDD principles (lightweight, implementation-agnostic, composable, human-first)
2. **Authentication** — bearer token; state what's implementation-defined vs spec-defined
3. **Error Format** — standard envelope (`code`, `message`, `details`); HTTP status → semantic mapping; global error codes
4. **Pagination** — cursor-based; request params (`limit`, `cursor`); response envelope (`items`, `next_cursor`, `limit`)
5. **Timestamps** — ISO 8601 UTC
6. **IDs** — opaque strings; UUID v4 recommended; state whether server or client assigns each resource's IDs
7. **[Domain] Scoping** — what's the top-level container; what query param scopes list operations
8. **Request/Response Format** — JSON; null handling; unknown fields ignored (forward compatibility)
9. **API Versioning** — version prefix (`/v1/`); what counts as a breaking change vs additive
10. **Out of Scope for v1** — explicit named list from Q8

### DATA-MODEL.md

Required for each entity:
- Entity overview tree (all entities and their parent-child relationships)
- Field table: `name`, `type`, `required`, `description` for every field
- Constraints section: uniqueness, immutability, valid state transitions, cascade rules, cross-references
- For each `id` field: state whether server or client assigns it and why (this affects API design)

Critical cross-check: every entity relationship in DATA-MODEL.md must match the relationship described in GLOSSARY.md's "How They Connect."

---

## Phase 3: Subsystem Spec Requirements

Each `specs/NN-[name].md` must contain:

### 1. Overview
2–3 paragraphs: what this subsystem does, why it exists, how it connects to adjacent subsystems. No implementation details.

### 2. User Stories
At least 3, in format: "As a [role], I can [action] so that [benefit]."
- The role comes from Q2
- The action must be specific enough that an engineer can implement it without asking clarifying questions
- The benefit must be a user goal, not an implementation task

### 3. Behavior Sections
One section per major behavior (e.g., "Hierarchy", "Ingestion", "Immutability"). Each section:
- States preconditions → operation → postconditions
- Makes state transitions explicit if the entity has states
- States ordering constraints if submission order matters
- States immutability rules (what can never change after creation)
- States cascade rules (what happens to children when parent is deleted)
- References CONSTITUTION.md and DATA-MODEL.md rather than restating their rules

### 4. Acceptance Criteria
At least 5 Given/When/Then scenarios. Must cover:
- The happy path (at least 1)
- Validation errors (at least 2 — different error codes)
- An edge case (at least 1)
- A delete/cascade scenario if the entity supports deletion

Every scenario must be independently testable: the GIVEN sets up its own preconditions; no scenario requires reading another to understand.

### 5. Edge Cases Table
At least 5 rows. Cover: empty inputs, invalid combinations, boundary values, concurrent operations (if applicable), partial states.

---

## Phase 4: API and UI Requirements

### specs/06-api.md

For each entity, provide all applicable endpoints:
- `POST /v1/[resource]` — create
- `GET /v1/[resource]/:id` — fetch single
- `GET /v1/[resource]` — list (with pagination params)
- `PATCH /v1/[resource]/:id` — update (only if entity has mutable fields)
- `DELETE /v1/[resource]/:id` — delete (only if deletion is supported)

For each endpoint:
- Method + path + one-sentence description
- Request body table: field, type, required, description + constraints
- Response: HTTP status + full JSON shape
- Error codes table: code, HTTP status, condition

Cross-subsystem operations need dedicated endpoints (e.g., `POST /v1/annotations/:id/to-dataset-item`).

Error code audit: every code used in any subsystem spec must be defined here or in CONSTITUTION.md. If any is missing, add it.

### specs/07-ui.md

**The critical rule:** Every prose sentence must answer "what can the user do?" — never "what does it look like?"

Forbidden in prose sections (acceptable inside acceptance criteria only):
- Directional layout words: left, right, top, bottom, two-column, side panel
- Component type words: text field, dropdown, modal, panel, inline form, text area
- Default-state prescriptions that don't affect user capability

For each view/page, write behavioral statements:
- ✅ "A developer can view all spans in a trace as a navigable tree and inspect each span's details."
- ❌ "Layout: Two-column. Left: span tree. Right: span detail panel."

The rendering contract (how different data types are displayed) is an exception — it can be prescriptive because it directly affects what the user sees.

---

## Phase 5: README Requirements

README.md must contain:
1. **One-sentence platform description**
2. **Reading order** — numbered list of every spec file in dependency order with a one-line description each
3. **Repository structure** — annotated file tree
4. **LLM Usage Guide** — table mapping implementation tasks to the spec files to include in context:
   - Implement subsystem N → `CONSTITUTION.md`, `DATA-MODEL.md`, `specs/NN.md`, `specs/06-api.md`
   - Build the UI → `CONSTITUTION.md`, `DATA-MODEL.md`, `specs/06-api.md`, `specs/07-ui.md`
   - Debug a spec question → `GLOSSARY.md` + relevant subsystem spec
   - Extend the data model → `GLOSSARY.md`, `CONSTITUTION.md`, `DATA-MODEL.md`, `specs/00-overview.md`
5. **Maintenance policy** — "Update the spec before or alongside code changes, never after."
