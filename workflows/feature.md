---
name: feature
description: Plan, write tests, implement, and review a new feature using TDD
triggers:
  - build a new feature
  - implement with TDD
  - plan and build

phases:
  - name: planning
    role: planner
    mode: single
    description: Analyze requirements and create a detailed implementation plan

  - name: approval
    mode: gate
    description: Review the plan before writing any code

  - name: testing
    role: test-writer
    mode: single
    description: Write failing tests that define the expected behavior
    contextFrom: planning

  - name: implementation
    role: builder
    mode: single
    description: Implement the code to make all tests pass
    contextFrom: testing

  - name: review
    role: reviewer
    mode: review-loop
    description: Review the implementation against the plan and tests
    fixRole: builder
    maxCycles: 3
    contextFrom: implementation

config:
  tokenLimit: 200000
---

Follow TDD strictly: tests must fail before implementation, pass after. The planner should identify all files that need to change. The builder should implement in small increments and run tests frequently.
