---
name: explore
description: Deep exploration with planning — scout first, then plan based on findings
triggers:
  - explore and plan
  - understand then design
  - deep dive with recommendations

phases:
  - name: exploration
    role: scout
    mode: single
    description: Broadly explore the codebase to map structure and patterns

  - name: planning
    role: planner
    mode: single
    description: Based on exploration findings, design an approach or recommendations
    contextFrom: exploration

config:
  tokenLimit: 80000
---

The scout should cast a wide net. The planner should synthesize findings into actionable recommendations.
