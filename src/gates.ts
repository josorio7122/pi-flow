import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Phase, GateResult } from './types.js';
import { getApprovalFrontmatterExample } from './templates.js';

// ─── Frontmatter parser ───────────────────────────────────────────────────────

/**
 * Extracts YAML frontmatter from a markdown file and parses it into a plain
 * object. Handles simple flat key-value pairs; nested structures are ignored.
 * Returns an empty object if the file has no frontmatter block.
 */
function parseFrontmatter(content: string): Record<string, unknown> {
  const result: Record<string, unknown> = {};

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
    result[key] = parseScalar(rawValue);
  }

  return result;
}

function parseScalar(raw: string): unknown {
  const s = raw.trim();
  if (s === 'true') return true;
  if (s === 'false') return false;
  if (s === 'null' || s === '~') return null;
  const n = Number(s);
  if (!Number.isNaN(n) && s !== '') return n;
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    return s.slice(1, -1);
  }
  return s;
}

// ─── Gate helpers ─────────────────────────────────────────────────────────────

function fileExists(filePath: string): boolean {
  return fs.existsSync(filePath);
}

function readFrontmatter(filePath: string): Record<string, unknown> {
  try {
    const content = fs.readFileSync(filePath, 'utf8');
    return parseFrontmatter(content);
  } catch {
    return {};
  }
}

// ─── Individual gate functions ────────────────────────────────────────────────

/**
 * INTENT gate: always passes — the coordinator receives raw user input
 * and no prior artifact is required.
 */
export function gateIntent(_featureDir: string): GateResult {
  return { canAdvance: true, reason: 'intent phase has no entry gate' };
}

/**
 * SPEC gate (INTENT → SPEC): brief.md must exist.
 * Auto-satisfied immediately after INTENT writes the brief.
 */
export function gateSpec(featureDir: string): GateResult {
  const briefPath = path.join(featureDir, 'brief.md');
  if (!fileExists(briefPath)) {
    return { canAdvance: false, reason: 'brief.md does not exist — run INTENT phase first' };
  }
  return { canAdvance: true, reason: 'brief.md present — ready for SPEC' };
}

/**
 * ANALYZE gate (SPEC → ANALYZE): spec.md must exist and be approved.
 */
export function gateAnalyze(featureDir: string): GateResult {
  const specPath = path.join(featureDir, 'spec.md');
  if (!fileExists(specPath)) {
    return { canAdvance: false, reason: 'spec.md does not exist — run SPEC phase first' };
  }
  const fm = readFrontmatter(specPath);
  if (fm.approved !== true) {
    const example = getApprovalFrontmatterExample();
    return {
      canAdvance: false,
      reason:
        `spec.md is not approved (approved=${String(fm.approved ?? 'missing')}) — human approval required.\n` +
        `Expected frontmatter format:\n${example}`,
    };
  }
  return { canAdvance: true, reason: 'spec.md approved — ready for ANALYZE' };
}

/**
 * PLAN gate (ANALYZE → PLAN): analysis.md must exist.
 */
export function gatePlan(featureDir: string): GateResult {
  const analysisPath = path.join(featureDir, 'analysis.md');
  if (!fileExists(analysisPath)) {
    return { canAdvance: false, reason: 'analysis.md does not exist — run ANALYZE phase first' };
  }
  return { canAdvance: true, reason: 'analysis.md present — ready for PLAN' };
}

/**
 * EXECUTE gate (PLAN → EXECUTE): design.md must exist and be approved,
 * and tasks.md must exist.
 */
export function gateExecute(featureDir: string): GateResult {
  const designPath = path.join(featureDir, 'design.md');
  if (!fileExists(designPath)) {
    return { canAdvance: false, reason: 'design.md does not exist — run PLAN phase first' };
  }
  const fm = readFrontmatter(designPath);
  if (fm.approved !== true) {
    const example = getApprovalFrontmatterExample();
    return {
      canAdvance: false,
      reason:
        `design.md is not approved (approved=${String(fm.approved ?? 'missing')}) — human approval required.\n` +
        `Expected frontmatter format:\n${example}`,
    };
  }
  const tasksPath = path.join(featureDir, 'tasks.md');
  if (!fileExists(tasksPath)) {
    return {
      canAdvance: false,
      reason: 'tasks.md does not exist — Planner must write task breakdown first',
    };
  }
  return {
    canAdvance: true,
    reason: 'design.md approved and tasks.md present — ready for EXECUTE',
  };
}

/**
 * REVIEW gate (EXECUTE → REVIEW): no open HALTs in sentinel-log.md.
 * If sentinel-log.md is absent, there are no HALTs by definition.
 */
export function gateReview(featureDir: string): GateResult {
  const sentinelPath = path.join(featureDir, 'sentinel-log.md');
  if (!fileExists(sentinelPath)) {
    return { canAdvance: true, reason: 'no sentinel-log.md — no open HALTs, ready for REVIEW' };
  }
  const fm = readFrontmatter(sentinelPath);
  const openHalts = Number(fm.open_halts ?? 0);
  if (openHalts > 0) {
    return {
      canAdvance: false,
      reason: `${openHalts} open HALT(s) in sentinel-log.md — all HALTs must be resolved before REVIEW`,
    };
  }
  return { canAdvance: true, reason: 'no open HALTs — ready for REVIEW' };
}

/**
 * SHIP gate (REVIEW → SHIP): review.md must exist with verdict === 'PASSED'.
 */
export function gateShip(featureDir: string): GateResult {
  const reviewPath = path.join(featureDir, 'review.md');
  if (!fileExists(reviewPath)) {
    return { canAdvance: false, reason: 'review.md does not exist — run REVIEW phase first' };
  }
  const fm = readFrontmatter(reviewPath);
  if (fm.verdict !== 'PASSED') {
    return {
      canAdvance: false,
      reason: `review.md verdict is "${String(fm.verdict ?? 'missing')}" — must be PASSED before shipping`,
    };
  }
  return { canAdvance: true, reason: 'review passed — ready for SHIP' };
}

// ─── Router ───────────────────────────────────────────────────────────────────

/**
 * Checks whether the workflow can advance TO `targetPhase`.
 * Each gate reads the handoff file from the prior phase and verifies
 * that all required conditions are met.
 *
 * All operations are synchronous and side-effect-free
 * (read-only: fs.existsSync + fs.readFileSync).
 */
export function checkPhaseGate(targetPhase: Phase, featureDir: string): GateResult {
  switch (targetPhase) {
    case 'intent':
      return gateIntent(featureDir);
    case 'spec':
      return gateSpec(featureDir);
    case 'analyze':
      return gateAnalyze(featureDir);
    case 'plan':
      return gatePlan(featureDir);
    case 'execute':
      return gateExecute(featureDir);
    case 'review':
      return gateReview(featureDir);
    case 'ship':
      return gateShip(featureDir);
  }
}
