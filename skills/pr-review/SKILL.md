---
name: pr-review
description: Deep review of GitHub Pull Requests. Fetches metadata, full diff, all comments, inline review comments with code context, review states, CI checks, and reads all changed files in full. Use when given a GitHub PR URL to review.
compatibility: Requires gh CLI authenticated. Run: gh auth status
metadata:
  author: josorio7122
  version: "1.0"
---

# PR Review

Deep GitHub PR review using the `gh` CLI. Fetches everything needed for a thorough review.

## Prerequisites

GitHub CLI must be installed and authenticated:
```bash
gh auth status
```

## Fetch All PR Data

Run this first for any PR URL:
```bash
{baseDir}/fetch-pr.ts <pr-url>
```

Supports:
- `https://github.com/owner/repo/pull/123`
- `owner/repo#123`

This outputs:
- PR metadata (title, author, branches, additions/deletions, labels)
- CI check status
- Changed files list
- Full diff (truncated to 50KB if large, full diff saved to temp file)
- All timeline comments
- All inline review comments with diff hunk context
- All reviews with state (APPROVED / CHANGES_REQUESTED / COMMENTED)
- All commits

## Review Process

Follow these steps in order:

1. **Run fetch-pr.ts** to get all PR data.

2. **Read linked issues** — check the PR body, comments, and commit messages for issue references (`#123`, `fixes #123`, etc.). For each:
   ```bash
   gh issue view <number> --repo <owner>/<repo> --json title,body,comments
   ```

3. **Read every changed file in full** using the `read` tool — one file at a time, no truncation. Do not rely solely on the diff patch. Also read:
   - Files that call or import changed code (callers, consumers)
   - Test files covering changed code
   - Type definitions or interfaces affected by the change

4. **Check unresolved review comments** — from the inline review comments section, identify any that haven't been addressed by a subsequent commit or reply.

5. **Check CI** — flag any failing or pending checks. Note which checks are blocking merge.

6. **Write the structured review**:

```
PR: <url>
Author: <author>
Branch: <head> → <base>
CI: <passing|failing|pending> (<N> checks, <N> failing)

Good:
- (solid choices, improvements, well-written code)

Bad:
- (concrete issues, logic errors, regressions, missing tests, risks)

Ugly:
- (subtle or high-impact problems, security issues, breaking changes)

Unresolved Review Comments:
- (prior review comments not yet addressed)

Questions or Assumptions:
- (anything unclear needing author clarification)

Change Summary:
- (concise bullets of what the PR does)

Tests:
- (what is tested, what coverage is missing)
```

If no issues are found under Bad or Ugly, say so explicitly — don't leave them blank.
