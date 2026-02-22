# Audit

Check existing code against the design system for violations.

## Usage

The user may say: "audit my components", "check for design drift", "audit `src/components/`", etc.

```
audit <path>     # Audit a specific file or directory
audit            # Audit common UI paths (src/components, src/ui, src/app, etc.)
```

## Process

### If `.interface-design/system.md` exists

Parse the system and check UI files (`.tsx`, `.jsx`, `.vue`, `.svelte`, `.css`, `.scss`) against it.

**Spacing violations**
- Find spacing values not on the defined grid
- Example: `17px` when base is `4px` (nearest valid values: `16px` or `20px`)

**Depth violations**
- Borders-only system → flag any `box-shadow` that isn't a focus ring (`0 0 0 Npx`)
- Subtle system → flag layered or dramatic shadows
- Layered system → flag flat borders-only usage on elevated surfaces

**Color violations**
- Flag hex values or CSS variables not in the defined palette
- Allow semantic grays and system-level colors (e.g. `transparent`, `currentColor`)

**Pattern drift**
- Find buttons not matching the Button pattern (height, padding, radius)
- Find cards not matching the Card pattern (border, padding, radius)
- Flag new component patterns that should be documented

**Report format:**
```
Audit: src/components/

Violations:
  Button.tsx:12    height: 38px        (pattern: 36px)
  Card.tsx:8       box-shadow used     (system: borders-only)
  Input.tsx:20     padding: 14px       (grid: 4px base, nearest: 12px or 16px)
  Badge.tsx:5      color: #e2e8f0      (not in palette)

Suggestions:
  - Update Button height to 36px
  - Replace box-shadow with border on Card
  - Adjust Input padding to 12px or 16px
  - Map Badge color to --color-surface-muted or add to palette
```

### If no system.md

```
No design system to audit against.

To create one:
  1. Build UI → system will be established and offered for saving automatically
  2. Ask me to extract a system from existing code
```

## Notes

- Focus on structural violations (spacing, depth, color) over stylistic preferences
- Don't flag variations that are intentionally handled via props
- One-off components don't need to match patterns exactly — flag only repeated divergence
