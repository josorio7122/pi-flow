# Agent Instructions

## Package Manager
Use **npm**: `npm install`, `npm test`, `npm run check`

## File-Scoped Commands
| Task | Command |
|------|---------|
| Typecheck | `npx tsc --noEmit` |
| Lint | `npx biome check path/to/file.ts` |
| Lint fix | `npx biome check --fix path/to/file.ts` |
| Test file | `npx vitest run path/to/file.test.ts` |
| Test watch | `npx vitest path/to/file.test.ts` |
| All checks | `npm run check` |

## Commit Attribution
Never add `Co-Authored-By` trailers or any AI attribution to commit messages.

## TypeScript Rules

### No `any` — zero tolerance
- `any` is banned in production code (enforced by eslint)
- Use `unknown` + type narrowing, Zod schemas, or generics
- Test files may use `any` sparingly for stubs

### Prefer type inference
- Never annotate what the compiler already knows
- No return type annotations — let TS infer them
- Justified exceptions: type predicates (`x is T`), factory functions that widen initial values, discriminated union returns needed for narrowing, and public API contracts
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

### Code splitting
- 200 lines max per file — split when exceeded
- Legacy sub-agent files (index.ts, manager.ts, runner.ts, command.ts, widget.ts, viewer.ts) exceed this limit — they were adopted from tintinweb/pi-subagents and are not refactored unless actively modified. New code must comply.
- Split by cohesion: related functions stay together, unrelated concepts get their own file
- Feature folders over layer folders — group by domain (`agents/`, `dispatch/`), not by role (`utils/`, `services/`)
- No barrel files (`index.ts` re-exports) — they break tree-shaking, hide circular deps, and slow builds. Use direct imports
- Export only what other modules consume — internal helpers stay unexported
- After any refactor that changes APIs, removes return types, or converts patterns — grep for orphaned types/interfaces/consts that lost all references
- Split triggers: file > 200 lines, 2+ unrelated concepts, or a function reused from another module

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
- Test behavior, not implementation details — tests must survive refactors that don't change behavior
- Every test must catch a real bug if it fails — if deleting it changes nothing, delete it
- No testing trivial code: getters, setters, type existence, enum member counts
- No snapshot abuse — snapshots hide regressions instead of catching them
- No `class TestXxx` — use plain `describe`/`it` with vitest
- No over-documentation in tests — rename the test if it needs explanation

### Mocking rules
- Pure function extraction is the #1 testing strategy — extract logic into pure functions, test them directly, no mocks needed
- Prefer `vi.spyOn` over `vi.mock` — spy on specific functions, don't replace entire modules
- `vi.mock` is a last resort — only for modules that are entirely I/O (fs, network, DB)
- Prefer fakes and real objects over mocks — a fake in-memory store beats a mocked repository
- Never mock what you own — if you control the code, make it testable by design (dependency injection, pure functions)
- If a test needs more than 2 mocks, the code under test has too many dependencies — refactor first

## Conventions
- ESM-only (`type: "module"`, `.js` extensions in imports)
- Colocate tests: `foo.ts` → `foo.test.ts` in same directory
- Types live next to the code that uses them — except shared project-wide types
- Unused code is deleted, not commented out
