import * as fs from 'node:fs';
import * as path from 'node:path';
import type { FlowState, Phase } from './types.js';

// ─── readFrontmatter ──────────────────────────────────────────────────────────

/**
 * Extracts YAML frontmatter from a markdown string and returns it as a
 * Record<string, string> with raw (un-coerced) string values.
 * Returns an empty object if no frontmatter block is present.
 */
export function readFrontmatter(content: string): Record<string, string> {
  const result: Record<string, string> = {};
  const lines = content.split('\n');
  if (lines[0]?.trim() !== '---') return result;

  let end = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i]?.trim() === '---') {
      end = i;
      break;
    }
  }
  if (end === -1) return result;

  for (let i = 1; i < end; i++) {
    const line = lines[i];
    if (!line || line.trimStart().startsWith('#')) continue;
    const colonIdx = line.indexOf(':');
    if (colonIdx === -1) continue;
    const key = line.slice(0, colonIdx).trim();
    const rawValue = line.slice(colonIdx + 1).trim();
    if (!key || rawValue === '') continue;
    result[key] = rawValue;
  }

  return result;
}

// ─── findFlowDir ──────────────────────────────────────────────────────────────

/**
 * Walks up from `cwd` looking for a `.flow/` directory.
 * Returns the absolute path to the first `.flow/` found, or null if none exists.
 */
export function findFlowDir(cwd: string): string | null {
  let dir = cwd;
  while (true) {
    const candidate = path.join(dir, '.flow');
    try {
      if (fs.statSync(candidate).isDirectory()) return candidate;
    } catch {
      // not found at this level — keep climbing
    }
    const parent = path.dirname(dir);
    if (parent === dir) return null; // filesystem root
    dir = parent;
  }
}

// ─── ensureFlowDir ────────────────────────────────────────────────────────────

/**
 * Creates `.flow/` inside `cwd` if it does not already exist.
 * Returns the absolute path to the `.flow/` directory.
 */
export function ensureFlowDir(cwd: string): string {
  const flowDir = path.join(cwd, '.flow');
  fs.mkdirSync(flowDir, { recursive: true });
  return flowDir;
}

// ─── ensureFeatureDir ─────────────────────────────────────────────────────────

/**
 * Creates `.flow/features/<feature>/` and its `checkpoints/` subdirectory.
 * Returns the absolute path to the feature directory.
 */
export function ensureFeatureDir(cwd: string, feature: string): string {
  const featureDir = path.join(cwd, '.flow', 'features', feature);
  const checkpointsDir = path.join(featureDir, 'checkpoints');
  fs.mkdirSync(checkpointsDir, { recursive: true });
  return featureDir;
}

// ─── readStateFile ────────────────────────────────────────────────────────────

/**
 * Reads `<featureDir>/state.md` and parses its YAML frontmatter into FlowState.
 * Returns null if the file does not exist or its frontmatter is missing required fields.
 */
export function readStateFile(featureDir: string): FlowState | null {
  const statePath = path.join(featureDir, 'state.md');
  if (!fs.existsSync(statePath)) return null;
  try {
    const content = fs.readFileSync(statePath, 'utf8');
    return parseStateContent(content);
  } catch {
    return null;
  }
}

// ─── writeStateFile ───────────────────────────────────────────────────────────

/**
 * Writes `<featureDir>/state.md` with a YAML frontmatter block serialised from
 * `state`. Any existing progress log below the frontmatter is preserved.
 * If state.md does not yet exist a `## Progress Log` section is added.
 */
export function writeStateFile(featureDir: string, state: FlowState): void {
  const statePath = path.join(featureDir, 'state.md');

  let body = '';
  if (fs.existsSync(statePath)) {
    const existing = fs.readFileSync(statePath, 'utf8');
    body = extractBody(existing);
  }

  const fm = serializeFlowState(state);
  const content = fm + (body !== '' ? body : '\n## Progress Log\n');
  fs.writeFileSync(statePath, content);
}

// ─── appendProgressLog ────────────────────────────────────────────────────────

/**
 * Appends a timestamped entry to the `## Progress Log` section of
 * `<featureDir>/state.md`.  Creates state.md (with empty frontmatter) if absent.
 */
export function appendProgressLog(featureDir: string, phase: Phase, message: string): void {
  const statePath = path.join(featureDir, 'state.md');

  const now = new Date();
  const ts = now.toISOString().replace('T', ' ').slice(0, 16);
  const entry = `\n### ${ts} — ${phase.toUpperCase()}\n${message}\n`;

  if (!fs.existsSync(statePath)) {
    fs.writeFileSync(statePath, `---\n---\n\n## Progress Log\n${entry}`);
    return;
  }

  const current = fs.readFileSync(statePath, 'utf8');
  fs.writeFileSync(statePath, current + entry);
}

// ─── readPhaseFile ────────────────────────────────────────────────────────────

/**
 * Reads any phase file (spec.md, analysis.md, etc.) from `featureDir`.
 * Returns null if the file does not exist.
 */
export function readPhaseFile(featureDir: string, filename: string): string | null {
  const filePath = path.join(featureDir, filename);
  if (!fs.existsSync(filePath)) return null;
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch {
    return null;
  }
}

// ─── writePhaseFile ───────────────────────────────────────────────────────────

/**
 * Writes a phase file to `<featureDir>/<filename>`.
 * Creates any intermediate directories as needed.
 */
export function writePhaseFile(featureDir: string, filename: string, content: string): void {
  const filePath = path.join(featureDir, filename);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
}

// ─── updateFrontmatter ────────────────────────────────────────────────────────

/**
 * Updates specific frontmatter fields in `<featureDir>/<filename>` without
 * touching the markdown body.  Existing keys are overwritten in-place;
 * new keys are inserted before the closing `---`.
 */
export function updateFrontmatter(
  featureDir: string,
  filename: string,
  updates: Record<string, string>,
): void {
  const filePath = path.join(featureDir, filename);
  const content = fs.readFileSync(filePath, 'utf8');
  const lines = content.split('\n');

  // If there is no frontmatter, prepend one.
  if (lines[0]?.trim() !== '---') {
    const fm: string[] = ['---'];
    for (const [k, v] of Object.entries(updates)) {
      fm.push(`${k}: ${v}`);
    }
    fm.push('---');
    fs.writeFileSync(filePath, fm.join('\n') + '\n' + content);
    return;
  }

  let end = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i]?.trim() === '---') {
      end = i;
      break;
    }
  }

  if (end === -1) {
    // Unclosed frontmatter — just append to end of file.
    const extra = Object.entries(updates).map(([k, v]) => `${k}: ${v}`);
    fs.writeFileSync(filePath, content + '\n' + extra.join('\n') + '\n');
    return;
  }

  const newLines = [...lines];
  const updatedKeys = new Set<string>();

  for (let i = 1; i < end; i++) {
    const line = lines[i];
    if (!line) continue;
    const colonIdx = line.indexOf(':');
    if (colonIdx === -1) continue;
    const key = line.slice(0, colonIdx).trim();
    if (key in updates) {
      newLines[i] = `${key}: ${updates[key]}`;
      updatedKeys.add(key);
    }
  }

  // Insert new keys before the closing ---.
  const toAdd: string[] = [];
  for (const [k, v] of Object.entries(updates)) {
    if (!updatedKeys.has(k)) {
      toAdd.push(`${k}: ${v}`);
    }
  }

  if (toAdd.length > 0) {
    newLines.splice(end, 0, ...toAdd);
  }

  fs.writeFileSync(filePath, newLines.join('\n'));
}

// ─── writeCheckpoint ─────────────────────────────────────────────────────────

/**
 * Writes a checkpoint XML file to `<featureDir>/checkpoints/`.
 * Filename: `<phase>.xml` (no wave) or `<phase>-wave-<n>.xml`.
 * Also copies the data to `latest.xml` — a regular file, not a symlink.
 */
export function writeCheckpoint(
  featureDir: string,
  phase: Phase,
  wave: number | null,
  data: string,
): void {
  const checkpointsDir = path.join(featureDir, 'checkpoints');
  fs.mkdirSync(checkpointsDir, { recursive: true });

  const filename = wave !== null ? `${phase}-wave-${wave}.xml` : `${phase}.xml`;
  const checkpointPath = path.join(checkpointsDir, filename);
  fs.writeFileSync(checkpointPath, data);

  // Copy to latest.xml — not a symlink (fragile on Windows).
  const latestPath = path.join(checkpointsDir, 'latest.xml');
  fs.copyFileSync(checkpointPath, latestPath);
}

// ─── readCheckpoint ───────────────────────────────────────────────────────────

/**
 * Reads the latest checkpoint from `<featureDir>/checkpoints/latest.xml`.
 * Returns null if the file does not exist.
 */
export function readCheckpoint(featureDir: string): string | null {
  const latestPath = path.join(featureDir, 'checkpoints', 'latest.xml');
  if (!fs.existsSync(latestPath)) return null;
  try {
    return fs.readFileSync(latestPath, 'utf8');
  } catch {
    return null;
  }
}

// ─── writeDispatchLog ─────────────────────────────────────────────────────────

/**
 * Writes an audit entry to `.flow/dispatches/<iso-timestamp>-<agent>-<feature>.md`.
 * Creates the `dispatches/` directory if it does not exist.
 * Colons in the ISO timestamp are replaced with dashes for filesystem safety.
 */
export function writeDispatchLog(flowDir: string, feature: string, entry: object): void {
  const dispatchesDir = path.join(flowDir, 'dispatches');
  fs.mkdirSync(dispatchesDir, { recursive: true });

  const ts = new Date().toISOString().replace(/:/g, '-').replace(/\./g, '-');
  const agent = String((entry as Record<string, unknown>).agent ?? 'unknown');
  const filename = `${ts}-${agent}-${feature}.md`;
  const filePath = path.join(dispatchesDir, filename);

  const lines: string[] = ['---'];
  for (const [k, v] of Object.entries(entry)) {
    lines.push(`${k}: ${JSON.stringify(v)}`);
  }
  lines.push('---', '');

  fs.writeFileSync(filePath, lines.join('\n'));
}

// ─── Internal helpers ─────────────────────────────────────────────────────────

/**
 * Returns the body (everything after the closing `---`) of a markdown file.
 * Returns an empty string when the file has no recognised frontmatter.
 */
function extractBody(content: string): string {
  const lines = content.split('\n');
  if (lines[0]?.trim() !== '---') return content;

  let end = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i]?.trim() === '---') {
      end = i;
      break;
    }
  }
  if (end === -1) return '';
  return lines.slice(end + 1).join('\n');
}

/**
 * Serialises a FlowState into a YAML frontmatter block.
 * Nested objects are flattened with underscore-delimited keys so that the
 * output is parseable with the simple single-level readFrontmatter.
 */
function serializeFlowState(state: FlowState): string {
  const skipped = state.skipped_phases.length > 0 ? `[${state.skipped_phases.join(', ')}]` : '[]';

  const lines = [
    '---',
    `feature: ${state.feature}`,
    `change_type: ${state.change_type}`,
    `current_phase: ${state.current_phase}`,
    `current_wave: ${state.current_wave ?? 'null'}`,
    `wave_count: ${state.wave_count ?? 'null'}`,
    `skipped_phases: ${skipped}`,
    `started_at: ${state.started_at}`,
    `last_updated: ${state.last_updated}`,
    `budget_total_tokens: ${state.budget.total_tokens}`,
    `budget_total_cost_usd: ${state.budget.total_cost_usd}`,
    `gates_spec_approved: ${state.gates.spec_approved}`,
    `gates_design_approved: ${state.gates.design_approved}`,
    `gates_review_verdict: ${state.gates.review_verdict ?? 'null'}`,
    `sentinel_open_halts: ${state.sentinel.open_halts}`,
    `sentinel_open_warns: ${state.sentinel.open_warns}`,
    '---',
    '',
  ];
  return lines.join('\n');
}

/**
 * Parses the frontmatter of a state.md string into a FlowState object.
 * Returns null if required fields are missing or the frontmatter is absent.
 */
function parseStateContent(content: string): FlowState | null {
  const lines = content.split('\n');
  if (lines[0]?.trim() !== '---') return null;

  let end = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i]?.trim() === '---') {
      end = i;
      break;
    }
  }
  if (end === -1) return null;

  const fields: Record<string, string> = {};
  for (let i = 1; i < end; i++) {
    const line = lines[i];
    if (!line || line.trimStart().startsWith('#')) continue;
    const colonIdx = line.indexOf(':');
    if (colonIdx === -1) continue;
    const key = line.slice(0, colonIdx).trim();
    const val = line.slice(colonIdx + 1).trim();
    if (key) fields[key] = val;
  }

  // Require the minimum fields.
  if (!fields['feature'] || !fields['current_phase']) return null;

  // Parse skipped_phases from inline array notation: [] or [spec, plan]
  let skipped_phases: Phase[] = [];
  const skippedRaw = fields['skipped_phases'] ?? '[]';
  if (skippedRaw !== '[]') {
    const inner = skippedRaw.replace(/^\[/, '').replace(/\]$/, '').trim();
    if (inner) {
      skipped_phases = inner.split(',').map((s) => s.trim() as Phase);
    }
  }

  // Parse nullable numbers.
  const toNullableInt = (v: string | undefined): number | null => {
    if (!v || v === 'null') return null;
    const n = Number(v);
    return Number.isNaN(n) ? null : n;
  };

  // Parse review_verdict (null or a string like "PASSED").
  const rawVerdict = fields['gates_review_verdict'];
  const review_verdict: string | null = !rawVerdict || rawVerdict === 'null' ? null : rawVerdict;

  return {
    feature: fields['feature'],
    change_type: (fields['change_type'] as FlowState['change_type']) ?? 'feature',
    current_phase: fields['current_phase'] as Phase,
    current_wave: toNullableInt(fields['current_wave']),
    wave_count: toNullableInt(fields['wave_count']),
    skipped_phases,
    started_at: fields['started_at'] ?? '',
    last_updated: fields['last_updated'] ?? '',
    budget: {
      total_tokens: Number(fields['budget_total_tokens'] ?? 0),
      total_cost_usd: Number(fields['budget_total_cost_usd'] ?? 0),
    },
    gates: {
      spec_approved: fields['gates_spec_approved'] === 'true',
      design_approved: fields['gates_design_approved'] === 'true',
      review_verdict,
    },
    sentinel: {
      open_halts: Number(fields['sentinel_open_halts'] ?? 0),
      open_warns: Number(fields['sentinel_open_warns'] ?? 0),
    },
  };
}
