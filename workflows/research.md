---
name: research
description: Scout the codebase to understand structure, find patterns, and report findings
triggers:
  - research something in the codebase
  - explore and report findings
  - understand how something works

phases:
  - name: scout
    role: scout
    mode: auto
    description: Explore the codebase and gather findings about the topic

config:
  tokenLimit: 50000
---

Focus on producing a thorough, well-structured report. Include file paths for every claim.
