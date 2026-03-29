# Agent Instructions

## Package Manager
Use **npm**: `npm install`, `npm test`, `npm run check`

## File-Scoped Commands
| Task | Command |
|------|---------|
| Typecheck | `npx tsc --noEmit` |
| Lint | `npx eslint path/to/file.ts` |
| Format | `npx prettier --write path/to/file.ts` |
| Test file | `npx vitest run path/to/file.test.ts` |
| Test watch | `npx vitest path/to/file.test.ts` |
| All checks | `npm run check` |

## Commit Attribution
AI commits MUST include:
```
Co-Authored-By: Claude <noreply@anthropic.com>
```

## TypeScript Rules

### No `any` — zero tolerance
- `any` is banned in production code (enforced by eslint)
- Use `unknown` + type narrowing, Zod schemas, or generics
- Test files may use `any` sparingly for stubs

### Prefer type inference
- Never annotate what the compiler already knows
- No return type annotations — let TS infer them
- No redundant variable annotations: `const x = 'hello'` not `const x: string = 'hello'`
- Annotate function parameters and public API contracts only

### Pure functions by default
- Default to pure functions: same input → same output, no side effects
- Push side effects (I/O, time, randomness) to the edges — pass them as arguments
- Use `readonly` for parameters that must not be mutated
- Impure shell, pure core (sandwich architecture)

### Object params for 3+ arguments
```ts
// ✗
function run(name: string, model: string, timeout: number) {}
// ✓
function run(params: { name: string; model: string; timeout: number }) {}
```

### File size limit: 200 lines max
- Split when a file exceeds 200 lines — no exceptions
- Extract helpers, types, or sub-modules

### Strict tsconfig is non-negotiable
- `strict: true` — always
- `noUncheckedIndexedAccess: true` — array/object index returns `T | undefined`
- `exactOptionalPropertyTypes: true` — `undefined` must be explicit, not implicit
- Never loosen these flags to fix type errors — fix the code instead

### Validate external data at runtime
- TS types vanish at runtime — API responses, file reads, env vars are `unknown` in practice
- Use Zod (or equivalent) at system boundaries to validate + infer types from one schema
- Never `as SomeType` on unvalidated external data

### Modern TS patterns
- Discriminated unions over optional fields + boolean flags
- `satisfies` to validate literals without widening
- `as const` for literal tuples and config objects
- `unknown` in catch blocks — narrow before using
- `using` declaration for resource cleanup (files, connections, temp dirs)
- Constrained generics (`extends`) over unconstrained `<T>`
- Utility types (`Pick`, `Omit`, `Partial`, `Record`) over manual redeclaration

## TDD Process

### Red → Green → Commit
1. Write a failing test first — run it, confirm red
2. Write the minimum code to pass — run it, confirm green
3. Commit test + implementation together

### Test quality rules
- Test behavior, not implementation details
- Every test must catch a real bug if it fails — if deleting it changes nothing, delete it
- No testing framework behavior (e.g., "field exists on type")
- Minimal mocking — prefer real objects, fakes, or pure function extraction
- Mock only at I/O boundaries (network, filesystem, time)
- No `class TestXxx` — use plain `describe`/`it` with vitest
- No over-documentation in tests — rename the test if it needs explanation

## Conventions
- ESM-only (`type: "module"`, `.js` extensions in imports)
- Colocate tests: `foo.ts` → `foo.test.ts` in same directory
- Types live next to the code that uses them, not in a monolithic `types.ts` — except shared project-wide types
- Unused code is deleted, not commented out
