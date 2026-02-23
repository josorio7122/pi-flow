# Changelog

All notable changes to pi-flow are documented here.

Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

---

## [Unreleased]

### Added
- `PROGRESS.md` pattern: implementer writes task status after each commit so sessions can resume mid-feature without re-reading the plan
- Resume protocol in `subagent-driven-development` skill: boot sequence reads `PROGRESS.md`, checks git log, verifies baseline before continuing
- Implementer hard-checks current branch on startup — refuses to run on `main`/`master` and instructs user to set up a worktree first
- Researcher saves findings to `docs/research/YYYY-MM-DD-<slug>.md` automatically when running inside a git repo

### Changed
- Package renamed from `agentic-dev-workflow` to `pi-flow`
- Install command: `pi install git:github.com/josorio7122/pi-flow`

### Removed
- `workflow-status` extension (removed from codebase and documentation)
- `context-budget` extension (removed from documentation)

---

## [1.0.0] — 2025-01-01

### Added
- Initial release with full greenfield and existing-codebase workflows
- 13 skills: research, understand-codebase, brainstorming, spec-writer, writing-plans, subagent-driven-development, using-git-worktrees, finishing-a-development-branch, pr-review, exa-search, brave-search, frontend-design, interface-design
- 11 agents: scout, researcher, architect, implementer, spec-reviewer, code-quality-reviewer, security-reviewer, debugger, reviewer, documenter, worker
- Three-gate review per task: spec compliance → code quality → security
- PR review extension with `gh` CLI integration
