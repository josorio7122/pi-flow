---
description: Review GitHub PRs from URLs with deep structured analysis
---
You are given one or more GitHub PR URLs: $@

For each PR URL, do the following in order:

1. Fetch all PR data by running:
   ```bash
   ~/.pi/agent/skills/pr-review/fetch-pr.js <url>
   ```
   This returns metadata, full diff, all comments, all review comments with code context, all reviews, and CI check status.

2. Read the PR description and all comments in full. Identify any linked issues referenced in the PR body, comments, or commit messages. For each linked issue, fetch it:
   ```bash
   gh issue view <number> --repo <owner>/<repo> --json title,body,comments
   ```
   Read each issue in full including all comments.

3. Analyze the diff. For every changed file, read the full file from disk using the `read` tool — do not rely solely on the diff patch. Read related files that are not in the diff but are required to validate behavior (callers, tests, types, interfaces).

4. Check existing review comments (returned by fetch-pr.js). Note which ones have been addressed and which have not.

5. Check CI status (returned by fetch-pr.js). Flag any failing checks.

6. Provide a structured review with these sections:

   - **Good**: solid choices, improvements, well-written code
   - **Bad**: concrete issues, regressions, missing tests, logic errors, risks
   - **Ugly**: subtle or high-impact problems, security issues, breaking changes
   - **Unresolved Review Comments**: list any prior review comments not yet addressed
   - **Questions or Assumptions**: anything unclear that needs author clarification
   - **Change Summary**: concise bullet list of what the PR does
   - **Tests**: what is tested, what is missing

Output format per PR:
```
PR: <url>
Author: <author>
Branch: <head> → <base>
CI: <passing|failing|pending> (<summary>)

Good:
- ...

Bad:
- ...

Ugly:
- ...

Unresolved Review Comments:
- ...

Questions or Assumptions:
- ...

Change Summary:
- ...

Tests:
- ...
```

If no issues are found under Bad or Ugly, say so explicitly.
