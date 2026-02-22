# Status

Display the current design system state for this project.

## Usage

The user may say: "show the design system", "what's the current system?", "design system status", etc.

## Process

### If `.interface-design/system.md` exists

Read the file and display a structured summary:

```
Design System: [Project Name or directory name]

Direction:  [Precision & Density / Warmth & Approachability / etc.]
Foundation: [Cool slate / Warm stone / Neutral / etc.]
Depth:      [Borders-only / Subtle shadows / Layered shadows / Surface shifts]

Tokens:
  Spacing base:   4px
  Spacing scale:  4, 8, 12, 16, 24, 32
  Radius scale:   4px, 6px, 8px, 12px
  Colors defined: [count or list]

Patterns:
  Button Primary  — 36px height, 12px 16px padding, 6px radius
  Card Default    — 1px border, 16px padding, 8px radius
  [other patterns...]

Last updated: [file mtime or git log date if available]
```

After displaying, offer next steps if useful:

```
Options:
  - Ask me to audit components against this system
  - Ask me to update a pattern
  - Ask me to add new patterns from recent work
```

### If no system.md

```
No design system found for this project.

Options:
  1. Start building UI — a system will be established and offered for saving automatically
  2. Ask me to extract a system from your existing code
```
