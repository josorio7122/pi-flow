# SDD Compliance Checklist

> This checklist is used by the `sdd-spec` skill to validate each artifact before moving to the next phase. Run all checks for the relevant artifact type. A spec is only SDD-compliant when every item passes.

---

## 1. GLOSSARY.md

- [ ] Every domain term used anywhere in the spec is defined here
- [ ] Each definition is 2–4 plain sentences — no jargon, no technical implementation details
- [ ] No definition mentions a database, framework, HTTP method, programming language, or library
- [ ] A "How They Connect" section exists and describes the core loop in prose (not a table or bullet list)
- [ ] The "How They Connect" section is readable by a non-engineer (PM, domain expert)
- [ ] The glossary adds no new terms that aren't used elsewhere in the spec

---

## 2. CONSTITUTION.md

- [ ] States the top design principles (lightweight, implementation-agnostic, composable, etc.)
- [ ] Defines the authentication model (what header format, what the platform does/doesn't specify)
- [ ] Defines a single error envelope format with `code`, `message`, `details`
- [ ] Maps every HTTP status code to a semantic meaning
- [ ] Lists global error codes (UNAUTHORIZED, NOT_FOUND, INVALID_REQUEST, etc.) used across the entire spec
- [ ] Defines pagination (cursor-based preferred for AI observability platforms with large datasets)
- [ ] Defines timestamp format (ISO 8601 UTC)
- [ ] Defines ID format and assignment rules
- [ ] Defines project scoping (how data is namespaced)
- [ ] Defines request/response format (JSON, null handling, forward-compatibility rules)
- [ ] Defines API versioning strategy
- [ ] Contains an explicit "Out of Scope for v1" section
- [ ] Contains NO implementation details (no database names, no framework names, no language names)

---

## 3. DATA-MODEL.md

- [ ] Lists every entity in an overview tree/diagram showing relationships
- [ ] Each entity has a full field table: name, type, required, description
- [ ] Each entity has a "Constraints" section describing: uniqueness, immutability, valid states, cascade rules
- [ ] Relationships between entities are explicit: one-to-many, many-to-one, etc.
- [ ] No field definition prescribes an implementation (no "stored in column X", "indexed by Y")
- [ ] Required vs optional is unambiguous for every field
- [ ] Nullable vs absent is distinguished for optional fields
- [ ] IDs: states whether server or client assigns each entity's ID (and the reason why)
- [ ] All timestamp fields reference the CONSTITUTION.md timestamp format

---

## 4. specs/00-overview.md (End-to-End Flow)

- [ ] Identifies all major workflows by name (e.g., "developer eval loop", "reviewer annotation loop")
- [ ] Each workflow is a complete prose narrative with numbered steps (not a bullet list)
- [ ] Each step in a workflow names the subsystem involved and references the spec file
- [ ] An ASCII or text-based data flow diagram shows every subsystem and the arrows between them
- [ ] Every arrow in the diagram corresponds to a real relationship in DATA-MODEL.md
- [ ] A reference table lists every spec file with what it covers and which workflow(s) it serves
- [ ] Key design decisions that shape the whole system are called out explicitly
- [ ] No implementation details (no HTTP verbs in prose, no database names, no framework names)
- [ ] Readable in under 5 minutes

---

## 5. Per-Subsystem Spec (specs/NN-name.md)

Each subsystem spec must pass all of the following:

### User Stories
- [ ] At least 3 user stories in "As a [role], I can [action] so that [benefit]" format
- [ ] Stories are written in plain language, not technical language
- [ ] Stories describe user goals, not implementation tasks

### Behavior Rules
- [ ] Behavior is described as preconditions, operations, and postconditions — not as code or implementation steps
- [ ] State transitions are explicit (if the entity has states)
- [ ] Ordering constraints are explicit (if submission order matters)
- [ ] Immutability rules are stated
- [ ] Cascade rules are stated (what happens to child entities when parent is deleted)
- [ ] All cross-references to CONSTITUTION.md and DATA-MODEL.md are present where rules were inherited

### Acceptance Criteria
- [ ] At least 5 Given/When/Then scenarios per subsystem
- [ ] Every scenario is independently testable (no scenario requires reading another scenario to understand)
- [ ] Scenarios cover: the happy path, at least 2 validation errors, at least 1 edge case
- [ ] Scenarios do NOT prescribe implementation (no "the database should...", "the service should...")
- [ ] Every referenced error code exists in CONSTITUTION.md or specs/06-api.md

### Edge Cases
- [ ] A table of edge cases with expected behavior for each
- [ ] At least 5 edge cases per subsystem
- [ ] Edge cases cover: empty inputs, invalid combinations, boundary conditions, concurrent operations (if applicable)

### Prose Sections
- [ ] No layout/implementation language (no "left panel", "right panel", "two-column", "modal", "dropdown" — unless in a UI acceptance criterion)
- [ ] No framework or database names
- [ ] Every prose sentence answers "what does the system do?" not "how does it do it?"

---

## 6. specs/06-api.md (HTTP API Contract)

- [ ] Every resource has: CREATE, READ (single), LIST, UPDATE (if applicable), DELETE (if applicable)
- [ ] Every endpoint has: method, path, brief description, request body (if applicable), response body, error codes
- [ ] Request bodies show every field, its type, whether required or optional, and constraints
- [ ] Response bodies show exactly what is returned (including which entity fields)
- [ ] Error codes reference the global list in CONSTITUTION.md or are defined inline with their HTTP status
- [ ] Pagination parameters are present on all list endpoints
- [ ] All paths use the version prefix (e.g., `/v1/`)
- [ ] No endpoint specifies a database operation or implementation detail
- [ ] Bulk/batch endpoints are specified where appropriate (e.g., span batch ingestion)
- [ ] Conversion endpoints are specified where features interact (e.g., annotation → dataset item)

---

## 7. specs/07-ui.md (UI Behavioral Spec)

- [ ] Describes what users CAN DO, not what the UI looks like
- [ ] No directional layout language (left, right, top, bottom, two-column, side panel)
- [ ] No component type prescriptions in prose (text field, dropdown, modal, panel) — these are acceptable only inside acceptance criteria
- [ ] No default-state prescriptions unless the default directly affects user capability
- [ ] Explicitly identifies distinct user roles and their access patterns
- [ ] Each view/page is described by the capabilities it grants, not its visual structure
- [ ] Rendering contract is specified (how different input/output types are displayed)
- [ ] Acceptance criteria follow the same Given/When/Then standard as subsystem specs
- [ ] Edge cases table covers: empty states, large data, error states, role-specific restrictions

---

## 8. Cross-Cutting Checks (apply to the whole spec)

- [ ] Every term used in any spec file is defined in GLOSSARY.md
- [ ] No spec file redefines behavior already stated in CONSTITUTION.md (it should reference instead)
- [ ] No spec file redefines entity shapes already stated in DATA-MODEL.md (it should reference instead)
- [ ] Every error code used in any spec file exists in CONSTITUTION.md or specs/06-api.md
- [ ] Every entity relationship described in prose matches the relationship table in DATA-MODEL.md
- [ ] The overview diagram in specs/00-overview.md matches the entity relationships in DATA-MODEL.md
- [ ] All spec files in the reading order exist and are referenced from README.md
- [ ] README.md contains a context-by-task table (what to include when asking an LLM about each subsystem)
