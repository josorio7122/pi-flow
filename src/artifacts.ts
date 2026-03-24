/**
 * Artifact write-back — the extension writes agent output to the correct path.
 *
 * This eliminates wrong-path bugs (e.g., reviewer writing review.md to docs/).
 * Agents return text output; the extension writes it to {{FEATURE_DIR}}/{artifact}.
 *
 * Special cases:
 * - Scout: appends with a domain header (parallel scouts build analysis.md incrementally)
 * - Builder: skipped (builder writes code directly, updates tasks.md in-place)
 * - All others: overwrite the artifact file
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { FlowAgentConfig } from './types.js';

/** Agents that write their own files — the extension should NOT overwrite their output. */
const SELF_WRITING_AGENTS = new Set(['builder']);

/** Agents whose output is appended (not overwritten) to support parallel dispatch. */
const APPEND_AGENTS = new Set(['scout']);

/**
 * Writes an agent's output to the appropriate artifact file in featureDir.
 *
 * - Scout: appends with `## Scout: {task}` header
 * - Builder: skipped (writes its own files)
 * - Others: overwrites the artifact file
 */
export function writeArtifact(
  featureDir: string,
  agent: FlowAgentConfig,
  output: string,
  task: string,
): void {
  if (SELF_WRITING_AGENTS.has(agent.name)) return;
  if (agent.writes.length === 0) return;

  const artifactName = agent.writes[0];
  const artifactPath = path.join(featureDir, artifactName);

  // Ensure directory exists
  fs.mkdirSync(featureDir, { recursive: true });

  if (APPEND_AGENTS.has(agent.name)) {
    // Append with domain header for parallel scouts
    const section = `## Scout: ${task}\n\n${output}\n\n`;
    fs.appendFileSync(artifactPath, section);
  } else {
    // Overwrite for planner, reviewer, etc.
    fs.writeFileSync(artifactPath, output);
  }
}
