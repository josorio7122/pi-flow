import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  checkPhaseGate,
  gateIntent,
  gateSpec,
  gateAnalyze,
  gatePlan,
  gateExecute,
  gateReview,
  gateShip,
} from './gates.js';

let featureDir: string;

beforeEach(() => {
  featureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-flow-gates-test-'));
});

afterEach(() => {
  fs.rmSync(featureDir, { recursive: true, force: true });
});

// ─── helpers ────────────────────────────────────────────────────────────────

function writeFrontmatter(filePath: string, fields: Record<string, unknown>, body = ''): void {
  const lines = ['---'];
  for (const [k, v] of Object.entries(fields)) {
    lines.push(`${k}: ${JSON.stringify(v)}`);
  }
  lines.push('---');
  if (body) lines.push('', body);
  fs.writeFileSync(filePath, lines.join('\n') + '\n');
}

function writeFile(filePath: string, content: string): void {
  fs.writeFileSync(filePath, content);
}

// ─── intent gate ─────────────────────────────────────────────────────────────

describe('gateIntent', () => {
  it('always returns canAdvance: true', () => {
    const result = gateIntent(featureDir);
    expect(result.canAdvance).toBe(true);
  });
});

// ─── spec gate (INTENT → SPEC) ───────────────────────────────────────────────

describe('gateSpec', () => {
  it('fails when brief.md does not exist', () => {
    const result = gateSpec(featureDir);
    expect(result.canAdvance).toBe(false);
    expect(result.reason).toMatch(/brief\.md/);
  });

  it('passes when brief.md exists', () => {
    writeFile(path.join(featureDir, 'brief.md'), '# Brief\n\nsome content');
    const result = gateSpec(featureDir);
    expect(result.canAdvance).toBe(true);
  });
});

// ─── analyze gate (SPEC → ANALYZE) ──────────────────────────────────────────

describe('gateAnalyze', () => {
  it('fails when spec.md does not exist', () => {
    const result = gateAnalyze(featureDir);
    expect(result.canAdvance).toBe(false);
    expect(result.reason).toMatch(/spec\.md/);
  });

  it('fails when spec.md exists but approved is false', () => {
    writeFrontmatter(path.join(featureDir, 'spec.md'), { approved: false });
    const result = gateAnalyze(featureDir);
    expect(result.canAdvance).toBe(false);
    expect(result.reason).toMatch(/approved/i);
  });

  it('fails when spec.md exists but approved field is missing', () => {
    writeFrontmatter(path.join(featureDir, 'spec.md'), { feature: 'test' });
    const result = gateAnalyze(featureDir);
    expect(result.canAdvance).toBe(false);
    expect(result.reason).toMatch(/approved/i);
  });

  it('includes expected frontmatter format in approval failure reason', () => {
    writeFrontmatter(path.join(featureDir, 'spec.md'), { approved: false });
    const result = gateAnalyze(featureDir);
    expect(result.canAdvance).toBe(false);
    expect(result.reason).toContain('---');
    expect(result.reason).toContain('approved: true');
  });

  it('passes when spec.md exists and approved is true', () => {
    writeFrontmatter(path.join(featureDir, 'spec.md'), { approved: true });
    const result = gateAnalyze(featureDir);
    expect(result.canAdvance).toBe(true);
  });
});

// ─── plan gate (ANALYZE → PLAN) ──────────────────────────────────────────────

describe('gatePlan', () => {
  it('fails when analysis.md does not exist', () => {
    const result = gatePlan(featureDir);
    expect(result.canAdvance).toBe(false);
    expect(result.reason).toMatch(/analysis\.md/);
  });

  it('passes when analysis.md exists', () => {
    writeFile(path.join(featureDir, 'analysis.md'), '## Domain: auth\n\nSome findings.');
    const result = gatePlan(featureDir);
    expect(result.canAdvance).toBe(true);
  });
});

// ─── execute gate (PLAN → EXECUTE) ───────────────────────────────────────────

describe('gateExecute', () => {
  it('fails when design.md does not exist', () => {
    const result = gateExecute(featureDir);
    expect(result.canAdvance).toBe(false);
    expect(result.reason).toMatch(/design\.md/);
  });

  it('fails when design.md exists but not approved', () => {
    writeFrontmatter(path.join(featureDir, 'design.md'), { approved: false });
    const result = gateExecute(featureDir);
    expect(result.canAdvance).toBe(false);
    expect(result.reason).toMatch(/approved/i);
  });

  it('includes expected frontmatter format in design approval failure reason', () => {
    writeFrontmatter(path.join(featureDir, 'design.md'), { approved: false });
    const result = gateExecute(featureDir);
    expect(result.canAdvance).toBe(false);
    expect(result.reason).toContain('---');
    expect(result.reason).toContain('approved: true');
  });

  it('fails when design.md approved but tasks.md missing', () => {
    writeFrontmatter(path.join(featureDir, 'design.md'), { approved: true });
    const result = gateExecute(featureDir);
    expect(result.canAdvance).toBe(false);
    expect(result.reason).toMatch(/tasks\.md/);
  });

  it('passes when design.md approved and tasks.md exists', () => {
    writeFrontmatter(path.join(featureDir, 'design.md'), { approved: true });
    writeFile(path.join(featureDir, 'tasks.md'), '---\nwaves: 2\n---\n\n## Wave 1\n');
    const result = gateExecute(featureDir);
    expect(result.canAdvance).toBe(true);
  });
});

// ─── review gate (EXECUTE → REVIEW) ─────────────────────────────────────────

describe('gateReview', () => {
  it('passes when sentinel-log.md does not exist (no halts by default)', () => {
    const result = gateReview(featureDir);
    expect(result.canAdvance).toBe(true);
  });

  it('fails when sentinel-log.md has open_halts > 0', () => {
    writeFrontmatter(path.join(featureDir, 'sentinel-log.md'), { open_halts: 2 });
    const result = gateReview(featureDir);
    expect(result.canAdvance).toBe(false);
    expect(result.reason).toMatch(/halt/i);
  });

  it('fails when sentinel-log.md has open_halts: 1', () => {
    writeFrontmatter(path.join(featureDir, 'sentinel-log.md'), { open_halts: 1 });
    const result = gateReview(featureDir);
    expect(result.canAdvance).toBe(false);
  });

  it('passes when sentinel-log.md has open_halts: 0', () => {
    writeFrontmatter(path.join(featureDir, 'sentinel-log.md'), { open_halts: 0 });
    const result = gateReview(featureDir);
    expect(result.canAdvance).toBe(true);
  });
});

// ─── ship gate (REVIEW → SHIP) ───────────────────────────────────────────────

describe('gateShip', () => {
  it('fails when review.md does not exist', () => {
    const result = gateShip(featureDir);
    expect(result.canAdvance).toBe(false);
    expect(result.reason).toMatch(/review\.md/);
  });

  it('fails when review.md verdict is NEEDS_WORK', () => {
    writeFrontmatter(path.join(featureDir, 'review.md'), { verdict: 'NEEDS_WORK' });
    const result = gateShip(featureDir);
    expect(result.canAdvance).toBe(false);
    expect(result.reason).toMatch(/PASSED/i);
  });

  it('fails when review.md verdict is FAILED', () => {
    writeFrontmatter(path.join(featureDir, 'review.md'), { verdict: 'FAILED' });
    const result = gateShip(featureDir);
    expect(result.canAdvance).toBe(false);
  });

  it('fails when review.md has no verdict field', () => {
    writeFrontmatter(path.join(featureDir, 'review.md'), { feature: 'test' });
    const result = gateShip(featureDir);
    expect(result.canAdvance).toBe(false);
  });

  it('passes when review.md verdict is PASSED', () => {
    writeFrontmatter(path.join(featureDir, 'review.md'), { verdict: 'PASSED' });
    const result = gateShip(featureDir);
    expect(result.canAdvance).toBe(true);
  });
});

// ─── checkPhaseGate (top-level router) ───────────────────────────────────────

describe('checkPhaseGate', () => {
  it('intent always passes', () => {
    const result = checkPhaseGate('intent', featureDir);
    expect(result.canAdvance).toBe(true);
  });

  it('spec fails without brief.md', () => {
    const result = checkPhaseGate('spec', featureDir);
    expect(result.canAdvance).toBe(false);
  });

  it('spec passes with brief.md', () => {
    writeFile(path.join(featureDir, 'brief.md'), '# Brief');
    const result = checkPhaseGate('spec', featureDir);
    expect(result.canAdvance).toBe(true);
  });

  it('analyze fails without approved spec.md', () => {
    const result = checkPhaseGate('analyze', featureDir);
    expect(result.canAdvance).toBe(false);
  });

  it('analyze passes with approved spec.md', () => {
    writeFrontmatter(path.join(featureDir, 'spec.md'), { approved: true });
    const result = checkPhaseGate('analyze', featureDir);
    expect(result.canAdvance).toBe(true);
  });

  it('plan fails without analysis.md', () => {
    const result = checkPhaseGate('plan', featureDir);
    expect(result.canAdvance).toBe(false);
  });

  it('execute fails without approved design.md + tasks.md', () => {
    const result = checkPhaseGate('execute', featureDir);
    expect(result.canAdvance).toBe(false);
  });

  it('review passes with no sentinel-log.md (no open halts)', () => {
    const result = checkPhaseGate('review', featureDir);
    expect(result.canAdvance).toBe(true);
  });

  it('ship fails without review.md', () => {
    const result = checkPhaseGate('ship', featureDir);
    expect(result.canAdvance).toBe(false);
  });

  it('ship passes with PASSED verdict', () => {
    writeFrontmatter(path.join(featureDir, 'review.md'), { verdict: 'PASSED' });
    const result = checkPhaseGate('ship', featureDir);
    expect(result.canAdvance).toBe(true);
  });

  // ─── Skip-path aware gates ──────────────────────────────────────────────

  it('analyze auto-passes spec check when spec phase is not in pipeline (hotfix)', () => {
    // No spec.md exists — but hotfix skips spec phase
    const result = checkPhaseGate('analyze', featureDir, 'hotfix', []);
    expect(result.canAdvance).toBe(true);
    expect(result.reason).toContain('skipped');
  });

  it('analyze auto-passes spec check when spec phase is not in pipeline (config)', () => {
    const result = checkPhaseGate('analyze', featureDir, 'config', []);
    expect(result.canAdvance).toBe(true);
  });

  it('analyze still requires spec.md for feature type', () => {
    const result = checkPhaseGate('analyze', featureDir, 'feature', []);
    expect(result.canAdvance).toBe(false);
  });

  it('analyze auto-passes when spec is in skipped_phases override', () => {
    const result = checkPhaseGate('analyze', featureDir, 'feature', ['spec']);
    expect(result.canAdvance).toBe(true);
  });

  it('plan auto-passes analysis check when analyze phase is not in pipeline (docs)', () => {
    // No analysis.md — but docs skips analyze phase
    const result = checkPhaseGate('plan', featureDir, 'docs', []);
    expect(result.canAdvance).toBe(true);
    expect(result.reason).toContain('skipped');
  });

  it('plan still requires analysis.md for feature type', () => {
    const result = checkPhaseGate('plan', featureDir, 'feature', []);
    expect(result.canAdvance).toBe(false);
  });

  it('ship auto-passes review check when review phase is not in pipeline (docs)', () => {
    // No review.md — but docs skips review phase
    const result = checkPhaseGate('ship', featureDir, 'docs', []);
    expect(result.canAdvance).toBe(true);
    expect(result.reason).toContain('skipped');
  });

  it('ship auto-passes review check when review phase is not in pipeline (config)', () => {
    const result = checkPhaseGate('ship', featureDir, 'config', []);
    expect(result.canAdvance).toBe(true);
  });

  it('ship still requires review.md for feature type', () => {
    const result = checkPhaseGate('ship', featureDir, 'feature', []);
    expect(result.canAdvance).toBe(false);
  });
});
