---
name: ship
description: Pre-merge checklist for committing, pushing, and opening a PR/MR. Only when the user explicitly asks to commit, push, or ship.
---

### Ship checklist

Only run when the user explicitly asks to commit, push, or ship.
Never auto-commit or auto-push.

1. **Review the diff**: `git diff --staged` — read the full diff. Look for
   accidental changes, debug artifacts, TODO comments. Remove anything that
   shouldn't ship.

2. **Run tests**: run the project's test command from AGENTS.md, scoped to
   changed files.

3. **Lint**: run the project's linter from AGENTS.md on changed files.

4. **Commit**: follow the project's commit conventions from AGENTS.md.
   If no project convention exists, use `type(scope): description`.

5. **Push**: `git push` (set upstream if needed).

6. **PR/MR**: open with title, body, and issue link per AGENTS.md conventions.
   If no convention exists:
   - Title: concise summary of the change
   - Body: what changed, why, how to verify
   - Link the issue if applicable

If tests or lint fail, fix before committing. Do not use `--no-verify`.

### Write memory

After shipping, write decisions, patterns, and lessons to `.flow/memory/`.
