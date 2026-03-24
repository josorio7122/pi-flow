// ─── Artifact frontmatter templates ───────────────────────────────────────────
//
// Canonical templates for every gate artifact. These are injected into:
// - Agent prompts (so agents produce correct frontmatter)
// - Coordinator prompt (so the coordinator knows the format)
// - Gate error messages (so the LLM can self-correct in one attempt)
//
// The parser (gates.ts) stays strict: `approved: true` only. These templates
// ensure the LLM produces the correct format without guessing.

const TEMPLATES: Record<string, string> = {
  spec: `---
feature: {{FEATURE_NAME}}
version: 1
approved: false
---`,

  design: `---
feature: {{FEATURE_NAME}}
approved: false
---`,

  tasks: `---
feature: {{FEATURE_NAME}}
wave_count: 0
---`,

  'sentinel-log': `---
open_halts: 0
open_warns: 0
last_reviewed_wave: 0
---`,

  review: `---
feature: {{FEATURE_NAME}}
verdict: null
---`,
};

/**
 * All known artifact names.
 */
export const ARTIFACT_NAMES = Object.keys(TEMPLATES);

/**
 * Returns the raw frontmatter template for an artifact, or null if unknown.
 * Contains `{{FEATURE_NAME}}` placeholder.
 */
export function getArtifactTemplate(artifact: string): string | null {
  return TEMPLATES[artifact] ?? null;
}

/**
 * Returns the template with `{{FEATURE_NAME}}` replaced by the given feature name,
 * or null if the artifact is unknown.
 */
export function renderArtifactTemplate(artifact: string, featureName: string): string | null {
  const tpl = TEMPLATES[artifact];
  if (!tpl) return null;
  return tpl.replaceAll('{{FEATURE_NAME}}', featureName);
}

/**
 * Returns a string showing the exact frontmatter format for approving an artifact.
 * Used in coordinator prompts and gate error messages.
 */
export function getApprovalFrontmatterExample(): string {
  return `---
approved: true
---`;
}
