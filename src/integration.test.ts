/**
 * Integration test: simulates a full hotfix flow through the real
 * state machine — no mocks. Verifies gates, transitions, and auto-advance
 * work together correctly.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { checkPhaseGate } from './gates.js';
import { getNextPhase, getEffectivePipeline, isTerminalPhase } from './transitions.js';
import { buildNudgeMessage } from './prompt.js';
import type { FlowState, Phase } from './types.js';

let featureDir: string;

function writeFile(filePath: string, content: string) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
}

function writeFrontmatter(filePath: string, fields: Record<string, unknown>, body = '') {
  const lines = ['---'];
  for (const [k, v] of Object.entries(fields)) {
    lines.push(`${k}: ${v === null ? 'null' : String(v)}`);
  }
  lines.push('---', body);
  writeFile(filePath, lines.join('\n'));
}

function makeState(overrides: Partial<FlowState> = {}): FlowState {
  return {
    feature: 'fix-unknown-fallback',
    change_type: 'hotfix',
    current_phase: 'intent',
    current_wave: null,
    wave_count: null,
    skipped_phases: [],
    started_at: new Date().toISOString(),
    last_updated: new Date().toISOString(),
    budget: { total_tokens: 0, total_cost_usd: 0 },
    gates: { spec_approved: false, design_approved: false, review_verdict: null },
    sentinel: { open_halts: 0, open_warns: 0 },
    ...overrides,
  };
}

/**
 * Simulates what accumulateBudget does: check next gate, advance if passes.
 */
function simulateAutoAdvance(
  state: FlowState,
  dispatchedPhase: Phase,
  wave?: number,
): Phase {
  const hasMoreWaves =
    wave !== undefined &&
    (state.wave_count === null || wave < state.wave_count);

  if (hasMoreWaves) return dispatchedPhase;

  const next = getNextPhase(state.change_type, state.skipped_phases, dispatchedPhase);
  if (!next) return dispatchedPhase;

  const gate = checkPhaseGate(next, featureDir, state.change_type, state.skipped_phases);
  if (gate.canAdvance) return next;

  return dispatchedPhase;
}

beforeEach(() => {
  featureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-flow-integration-'));
});

afterEach(() => {
  fs.rmSync(featureDir, { recursive: true, force: true });
});

describe('integration: full hotfix flow', () => {
  it('hotfix pipeline is intent → analyze → plan → execute → review → ship', () => {
    expect(getEffectivePipeline('hotfix', [])).toEqual([
      'intent', 'analyze', 'plan', 'execute', 'review', 'ship',
    ]);
  });

  it('step 1: intent → auto-advances to analyze (spec skipped for hotfix)', () => {
    // Clarifier writes brief.md
    writeFile(path.join(featureDir, 'brief.md'), '# Brief\nReplace Unknown with empty');

    const state = makeState({ current_phase: 'intent' });
    const next = simulateAutoAdvance(state, 'intent');

    // Analyze gate auto-passes (spec not in hotfix pipeline)
    expect(next).toBe('analyze');
  });

  it('step 2: analyze → auto-advances to plan (analysis.md exists)', () => {
    writeFile(path.join(featureDir, 'analysis.md'), '# Analysis\n14 Unknown fallbacks found');

    const state = makeState({ current_phase: 'analyze' });
    const next = simulateAutoAdvance(state, 'analyze');

    expect(next).toBe('plan');
  });

  it('step 3: plan (strategist) → stays at plan (design.md not approved)', () => {
    writeFile(path.join(featureDir, 'analysis.md'), '# Analysis');
    writeFrontmatter(path.join(featureDir, 'design.md'), { approved: false });

    const state = makeState({ current_phase: 'plan' });
    const next = simulateAutoAdvance(state, 'plan');

    // Execute gate blocks: design.md not approved
    expect(next).toBe('plan');

    // Nudge should mention approval
    const nudge = buildNudgeMessage({ ...state, current_phase: 'plan' });
    expect(nudge).toContain('dispatch plan');
    expect(nudge).toContain('approval');
    expect(nudge).toContain('execute');
  });

  it('step 4: plan (planner, after approval) → advances to execute', () => {
    writeFrontmatter(path.join(featureDir, 'design.md'), { approved: true });
    writeFile(path.join(featureDir, 'tasks.md'), '---\nwave_count: 2\n---\n- [ ] task 1\n- [ ] task 2');

    const state = makeState({ current_phase: 'plan' });
    const next = simulateAutoAdvance(state, 'plan');

    // Execute gate passes: design.md approved + tasks.md exists
    expect(next).toBe('execute');
  });

  it('step 5: execute wave 1 → stays at execute (more waves)', () => {
    const state = makeState({ current_phase: 'execute', wave_count: 2 });
    const next = simulateAutoAdvance(state, 'execute', 1);

    expect(next).toBe('execute');
  });

  it('step 6: execute wave 2 (final) → advances to review', () => {
    const state = makeState({ current_phase: 'execute', wave_count: 2 });
    const next = simulateAutoAdvance(state, 'execute', 2);

    // Review gate: no sentinel-log.md = no HALTs = passes
    expect(next).toBe('review');
  });

  it('step 7: review → advances to ship (verdict PASSED)', () => {
    writeFrontmatter(path.join(featureDir, 'review.md'), { verdict: 'PASSED' });

    const state = makeState({ current_phase: 'review' });
    const next = simulateAutoAdvance(state, 'review');

    expect(next).toBe('ship');
  });

  it('step 8: ship is terminal', () => {
    expect(isTerminalPhase('hotfix', [], 'ship')).toBe(true);
    const nudge = buildNudgeMessage(makeState({ current_phase: 'ship' }));
    expect(nudge).toContain('complete');
  });
});

describe('integration: full feature flow with approval gates', () => {
  it('spec → stays at spec (spec.md not approved)', () => {
    writeFrontmatter(path.join(featureDir, 'spec.md'), { approved: false });

    const state = makeState({ change_type: 'feature', current_phase: 'spec' });
    const next = simulateAutoAdvance(state, 'spec');

    expect(next).toBe('spec');
  });

  it('spec → advances to analyze after spec.md approved', () => {
    writeFrontmatter(path.join(featureDir, 'spec.md'), { approved: true });

    const state = makeState({ change_type: 'feature', current_phase: 'spec' });
    const next = simulateAutoAdvance(state, 'spec');

    expect(next).toBe('analyze');
  });

  it('plan → stays at plan (design.md not approved)', () => {
    writeFrontmatter(path.join(featureDir, 'design.md'), { approved: false });

    const state = makeState({ change_type: 'feature', current_phase: 'plan' });
    const next = simulateAutoAdvance(state, 'plan');

    expect(next).toBe('plan');
  });

  it('plan → advances to execute after design.md approved + tasks.md exists', () => {
    writeFrontmatter(path.join(featureDir, 'design.md'), { approved: true });
    writeFile(path.join(featureDir, 'tasks.md'), '---\nwave_count: 1\n---\n- [ ] task 1');

    const state = makeState({ change_type: 'feature', current_phase: 'plan' });
    const next = simulateAutoAdvance(state, 'plan');

    expect(next).toBe('execute');
  });
});

describe('integration: docs flow (no spec, no analyze, no review)', () => {
  it('docs pipeline is intent → plan → execute → ship', () => {
    expect(getEffectivePipeline('docs', [])).toEqual([
      'intent', 'plan', 'execute', 'ship',
    ]);
  });

  it('intent → advances to plan (analyze skipped)', () => {
    const state = makeState({ change_type: 'docs', current_phase: 'intent' });
    const next = simulateAutoAdvance(state, 'intent');

    // Plan gate: analyze not in pipeline → auto-passes
    expect(next).toBe('plan');
  });

  it('plan → stays at plan (design.md not approved)', () => {
    writeFrontmatter(path.join(featureDir, 'design.md'), { approved: false });

    const state = makeState({ change_type: 'docs', current_phase: 'plan' });
    const next = simulateAutoAdvance(state, 'plan');

    expect(next).toBe('plan');
  });

  it('execute → advances to ship (review skipped)', () => {
    const state = makeState({ change_type: 'docs', current_phase: 'execute' });
    const next = simulateAutoAdvance(state, 'execute');

    // Ship gate: review not in pipeline → auto-passes
    expect(next).toBe('ship');
  });
});
