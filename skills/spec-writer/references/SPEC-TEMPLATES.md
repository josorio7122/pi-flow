# Spec Templates

> Canonical templates for each artifact the `sdd-spec` skill produces. Use these exactly. Fill in the bracketed placeholders. Add sections only when justified.

---

## Template: GLOSSARY.md

```markdown
# Glossary

> Plain-language definitions of every domain term used in this spec. Read this before anything else if any term feels unfamiliar. No technical jargon, no implementation details — just what things mean.

---

## Terms

### [Term Name]

[2–4 plain sentences. What it is, what it contains, how it behaves, why it exists. No database names, no HTTP methods, no framework names.]

### [Term Name]

[...]

---

## How They Connect

[3–5 paragraph prose narrative — NOT a list, NOT a table — describing the core loop of the system in plain English. Walk through the lifecycle from first action to final result. Every term defined above should appear at least once. This section must be readable by a non-engineer.]
```

---

## Template: CONSTITUTION.md

```markdown
# Constitution

> Cross-cutting rules that apply to every part of this spec. All sub-specs assume these without repeating them.

---

## Design Principles

1. **[Principle]** — [One sentence explanation.]
[...]

---

## Authentication

- All API endpoints require [describe the token mechanism].
- The platform does not specify how tokens are issued or validated — this is implementation-defined.
- Requests missing a valid token receive `401 Unauthorized` with error code `UNAUTHORIZED`.

---

## Error Format

All error responses use a consistent envelope regardless of status code:

\`\`\`json
{
  "error": {
    "code": "SNAKE_CASE_ERROR_CODE",
    "message": "Human-readable description of what went wrong.",
    "details": {}
  }
}
\`\`\`

### HTTP Status → Semantic Mapping

| Status | When to use |
|---|---|
| `200 OK` | Successful read or update |
| `201 Created` | Resource successfully created |
| `400 Bad Request` | Malformed request body or invalid field values |
| `401 Unauthorized` | Missing or invalid authentication token |
| `404 Not Found` | Resource does not exist |
| `409 Conflict` | Duplicate resource where uniqueness is required |
| `422 Unprocessable Entity` | Request is well-formed but semantically invalid |

### Global Error Codes

| Code | HTTP Status | Meaning |
|---|---|---|
| `UNAUTHORIZED` | 401 | Missing or invalid bearer token |
| `NOT_FOUND` | 404 | Requested resource does not exist |
| `INVALID_REQUEST` | 400 | Malformed or missing required fields in request body |
| `CONFLICT` | 409 | A resource with a conflicting unique identifier already exists |
[Add domain-specific global codes here]

---

## Pagination

All list endpoints use **cursor-based pagination**.

[Paste standard pagination block from the ai-observability-spec CONSTITUTION.md or adapt for this domain]

---

## Timestamps

[State format. ISO 8601 UTC is the default recommendation.]

---

## IDs

[State format. Opaque strings. UUID v4 recommended. State whether server or client assigns IDs for each resource type — this matters for the data model.]

---

## [Domain Name] Scoping

[How data is namespaced. What the top-level container is. What query parameter scopes list operations.]

---

## Request and Response Format

[JSON. Null handling. Forward compatibility (unknown fields ignored in both directions).]

---

## API Versioning

[Version prefix. What counts as a breaking change. What doesn't.]

---

## Out of Scope for v1

[Explicit list of what is NOT in this spec. Be specific. This prevents scope creep and documents decisions.]
```

---

## Template: DATA-MODEL.md

```markdown
# Data Model

> Canonical definitions of every core entity. All sub-specs reference this document for object shapes.

---

## Entity Overview

\`\`\`
[ASCII tree or diagram showing all entities and their relationships]
\`\`\`

[1–2 sentence description of the overall model and its key relationships.]

---

## [Entity Name]

[One sentence: what this entity represents.]

| Field | Type | Required | Description |
|---|---|---|---|
| `id` | string | yes | Unique identifier. [Assigned by server/client — state which and why.] |
| `[field]` | [type] | yes/no | [Description. State constraints inline if brief.] |
[...]

### [Entity Name] Constraints

- [Uniqueness rules]
- [Immutability rules]
- [Valid state transitions if applicable]
- [Cascade rules (what happens on delete)]
- [Cross-reference constraints]

---

[Repeat for each entity]

---

## Entity Relationship Summary

| Relationship | Cardinality |
|---|---|
| [Entity A] → [Entity B] | one-to-many |
[...]
```

---

## Template: specs/00-overview.md

```markdown
# Overview

> [One sentence: what the platform does.]

---

## The Problem This Platform Solves

[2–3 paragraphs. Why this domain requires a purpose-built platform. What goes wrong without it. What "good" looks like. No implementation details.]

---

## The [N] Workflows

### Workflow 1: [Name]

[Prose description with numbered steps. Each step: what the actor does → what subsystem is involved → what artifact is produced. Reference the relevant spec file parenthetically.]

### Workflow 2: [Name]

[Same format.]

---

## How the Subsystems Connect

\`\`\`
[ASCII data flow diagram. Every arrow must correspond to a real relationship in DATA-MODEL.md.]
\`\`\`

[1–2 sentences confirming every arrow maps to a real operation.]

---

## What Each Spec File Covers

| File | What it covers | Workflows |
|---|---|---|
| `CONSTITUTION.md` | [description] | Both |
| `DATA-MODEL.md` | [description] | Both |
| `specs/00-overview.md` | This file | Both |
| `specs/01-[name].md` | [description] | [workflow] |
[...]

---

## Key Design Decisions

[3–5 bullets or short paragraphs on the decisions that shape the whole system. Why they were made. What they prevent. Each should answer "why does this work this way?"]
```

---

## Template: specs/NN-subsystem.md

```markdown
# [Subsystem Name]

> [One sentence: what this subsystem does and why it exists.]

Cross-cutting rules (auth, errors, pagination, timestamps) are defined in `CONSTITUTION.md`. Object schemas are defined in `DATA-MODEL.md`.

---

## Overview

[2–3 paragraphs. What problem this subsystem solves. What it produces. How it connects to adjacent subsystems. No implementation details.]

---

## User Stories

- As a [role], I can [action] so that [benefit].
- As a [role], I can [action] so that [benefit].
- As a [role], I can [action] so that [benefit].
[At least 3. Add more if there are distinct use cases.]

---

## [Behavior Topic 1]

[Describe the rules governing this behavior. Preconditions → operation → postconditions. State transitions. Ordering constraints. Immutability rules. Reference DATA-MODEL.md for field definitions rather than repeating them.]

---

## [Behavior Topic 2]

[...]

---

## Acceptance Criteria

\`\`\`
GIVEN [precondition]
WHEN [action]
THEN [observable result]
[AND [additional observable result]]

[Repeat for each scenario. At least 5 total. Cover: happy path, validation errors (at least 2), edge cases (at least 1).]
\`\`\`

---

## Edge Cases

| Scenario | Expected Behavior |
|---|---|
| [Scenario description] | [What the system does] |
[At least 5 rows.]
```

---

## Template: specs/06-api.md (HTTP API Contract)

```markdown
# HTTP API

> Complete contract for the [Platform Name] HTTP API. Every endpoint, request shape, response shape, and error code.

Base URL: `https://[host]/v1`
Auth: All endpoints require `Authorization: Bearer <token>` (see `CONSTITUTION.md`).

---

## [Resource Name]

### POST /v1/[resource]

[One sentence: what this creates.]

**Request body:**

| Field | Type | Required | Description |
|---|---|---|---|
| `field` | type | yes/no | description |
[...]

**Response: `201 Created`**

\`\`\`json
{
  [full response shape with all fields and example values]
}
\`\`\`

**Errors:**

| Code | HTTP | Condition |
|---|---|---|
| `CONFLICT` | 409 | [When this fires] |
[...]

---

### GET /v1/[resource]/:id

[One sentence: what this returns.]

**Response: `200 OK`** — the [Entity] object (see `DATA-MODEL.md`).

**Errors:** `NOT_FOUND` if resource does not exist.

---

### GET /v1/[resource]

[One sentence: what this lists.]

**Query parameters:**

| Parameter | Type | Required | Default | Description |
|---|---|---|---|---|
| `[scope_id]` | string | yes | — | [scope description] |
| `limit` | integer | no | 50 | Max items. Max 200. |
| `cursor` | string | no | — | Pagination cursor. |

**Response: `200 OK`**

\`\`\`json
{
  "items": [...],
  "next_cursor": "string or null",
  "limit": 50
}
\`\`\`

---

### DELETE /v1/[resource]/:id

**Response: `200 OK`** — `{"deleted": true}`

**Errors:** `NOT_FOUND` if resource does not exist.

---

## Error Code Reference

| Code | HTTP | Meaning |
|---|---|---|
| `UNAUTHORIZED` | 401 | Missing or invalid token |
| `NOT_FOUND` | 404 | Resource not found |
| `INVALID_REQUEST` | 400 | Malformed request |
| `CONFLICT` | 409 | Duplicate resource |
[All global codes from CONSTITUTION.md plus any endpoint-specific codes]
```

---

## Template: specs/07-ui.md

```markdown
# UI Spec

> [One sentence: what the UI provides and who it serves.]

The UI consumes the HTTP API defined in `specs/06-api.md`. Cross-cutting rules are in `CONSTITUTION.md`. Object schemas are in `DATA-MODEL.md`.

---

## Overview

[2–3 sentences: the distinct user roles served, the entry points, what separates them.]

---

## Application Shell

[Describe shell-level capabilities: project selection, navigation between sections. Behavioral statements only — what the user can do, not what the shell looks like.]

---

## [Role/Section] View

### [View Name]

[Describe what the user can see and do. Every sentence: "A [role] can [action]" or "The [view] shows [data]". No layout words (left, right, two-column, panel, modal).]

**Must display:**

[Table of required data fields, their source (API field), and display notes.]

**Data sources:**
- `[HTTP endpoint]`

---

[Repeat for each view]

---

## Rendering Contract

[How different data types are rendered. Table: value type → how to display. This is behavioral: the user sees X, not "the component renders X".]

---

## Acceptance Criteria

\`\`\`
GIVEN [precondition]
WHEN [UI action]
THEN [observable result visible to the user]
[...]
\`\`\`

---

## Edge Cases

| Scenario | Expected Behavior |
|---|---|
| [Empty state] | [What the user sees] |
| [Error state] | [What the user sees] |
[At least 8 rows — empty states, errors, large data, role restrictions.]
```
