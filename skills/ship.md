---
name: ship
description: Pre-merge checklist for committing, pushing, and opening a PR/MR. Only runs when the user explicitly asks to commit, push, or ship.
trigger: when user asks to commit, push, or ship
---

### Ship checklist

Only run when the user explicitly asks to commit, push, or ship.
Never auto-commit or auto-push.

1. **Check status**: `git status` — review staged and unstaged changes
2. **Run tests**: run the project's test command scoped to changed files
3. **Lint**: run the project's linter on changed files
4. **Commit**: `git add` + `git commit` with format `type(scope): description`
   - Types: feat, fix, refactor, test, chore, docs
   - Scope: the module or area changed
   - Description: imperative, lowercase, no period
5. **Push**: `git push` (set upstream if needed)
6. **PR/MR**: open a pull/merge request with:
   - Title: concise summary
   - Body: what changed, why, how to test
   - Link to issue if applicable

If tests or lint fail, fix before committing. Do not use `--no-verify`.
