# Extract

Infer a design system from existing code and offer to write `.interface-design/system.md`.

## Usage

The user may say: "extract a system from my code", "create a system.md from what we have", "pull patterns from existing components", etc.

```
extract            # Scan common UI paths
extract <path>     # Scan a specific directory
```

## Process

Glob for UI files (`.tsx`, `.jsx`, `.vue`, `.svelte`, `.css`, `.scss`) in the target path.

### 1. Repeated spacing values

Tally all spacing values (padding, margin, gap, width, height where applicable).

```
Found: 4px (12×), 8px (23×), 12px (18×), 16px (31×), 24px (8×), 17px (1×), 22px (1×)
→ Suggests: Base 4px, Scale: 4, 8, 12, 16, 24 (outliers: 17px, 22px — flag as drift)
```

### 2. Repeated border-radius values

```
Found: 6px (28×), 8px (5×), 4px (9×)
→ Suggests: Radius scale: 4px (inputs), 6px (buttons/cards), 8px (modals)
```

### 3. Button patterns

```
Found 8 buttons:
  height: 36px (7×), 40px (1×)
  padding: 12px 16px (6×), 16px (2×)
  border-radius: 6px (8×)
→ Suggests: Button — 36px height, 12px 16px padding, 6px radius
```

### 4. Card patterns

```
Found 12 card-like surfaces:
  border: 1px solid (10×), none (2×)
  padding: 16px (9×), 20px (3×)
  border-radius: 8px (12×)
→ Suggests: Card — 1px border, 16px padding, 8px radius
```

### 5. Depth strategy

```
box-shadow found: 2×
border found: 34×
→ Suggests: Borders-only depth
```

### 6. Color palette

Collect all unique hex values and CSS variable names. Group by apparent role (foreground, background, border, accent, semantic).

---

## Output

Present findings and ask before writing:

```
Extracted patterns from src/components/:

Spacing:
  Base: 4px
  Scale: 4, 8, 12, 16, 24
  Outliers (not on grid): 17px in Input.tsx:20, 22px in Sidebar.tsx:8

Depth: Borders-only (34 borders vs. 2 shadows)

Border Radius:
  Scale: 4px, 6px, 8px

Patterns:
  Button: 36px height, 12px 16px padding, 6px radius
  Card: 1px border, 16px padding, 8px radius

Colors: [list unique values or CSS variables found]

Create .interface-design/system.md with these? (yes / no / let me customize)
```

If the user wants to customize, go through each section and let them confirm or adjust values before writing.

## Writing system.md

Use the template from `references/validation.md`. Save the extracted + confirmed values. Note the extraction date and source path as a comment at the top of the file.
