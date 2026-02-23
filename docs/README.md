# docs/

Internal artifacts generated during development of pi-flow itself. Not required reading for users of the package.

```
docs/
├── research/        # Research briefs — one file per topic, YYYY-MM-DD-<slug>.md
│   └── 2026-02-23-workflow-evaluation.md
└── plans/           # Implementation plans for feature work on this repo
    └── 2026-02-23-progress-tracking-and-rename.md
```

> **Note:** `docs/plans/PROGRESS.md` is runtime state written during active feature work. It is gitignored — you will only see it locally when a feature is in progress.

When you use pi-flow in your own projects, your project's `docs/research/` and `docs/plans/` directories follow the same convention — the researcher and implementer agents write there automatically.
