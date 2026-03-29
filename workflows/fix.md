---
name: fix
description: Scout a bug, get approval, fix it, then review the changes
triggers:
  - fix a bug or issue
  - scout and repair
  - find and fix

phases:
  - name: scout
    role: scout
    mode: single
    description: Scan the codebase to locate the bug and understand its root cause

  - name: approve
    mode: gate
    description: Review the scout's findings before proceeding with the fix

  - name: build
    role: builder
    mode: single
    description: Fix the identified issue and run tests
    contextFrom: scout

  - name: review
    role: reviewer
    mode: review-loop
    description: Review the fix for correctness and completeness
    fixRole: builder
    maxCycles: 3
    contextFrom: build

config:
  tokenLimit: 150000
---

The scout phase should identify the root cause, not just symptoms. The builder should run tests after every change.
