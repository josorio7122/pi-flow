import { describe, it, expect } from 'vitest';
import { inferPhase, inferFeature } from './inference.js';
import type { FlowState } from './types.js';

function makeState(overrides: Partial<FlowState> = {}): FlowState {
  return {
    feature: 'test',
    change_type: 'feature',
    current_phase: 'intent',
    current_wave: null,
    wave_count: null,
    skipped_phases: [],
    started_at: '',
    last_updated: '',
    budget: { total_tokens: 0, total_cost_usd: 0 },
    gates: { spec_approved: false, design_approved: false, review_verdict: null },
    sentinel: { open_halts: 0, open_warns: 0 },
    ...overrides,
  };
}

describe('inferPhase', () => {
  // ─── Basic mapping: agent → current_phase when agent is valid for it ──────

  it('clarifier at intent → intent', () => {
    expect(inferPhase('clarifier', makeState({ current_phase: 'intent' }))).toBe('intent');
  });

  it('clarifier at spec → spec', () => {
    expect(inferPhase('clarifier', makeState({ current_phase: 'spec' }))).toBe('spec');
  });

  it('scout at analyze → analyze', () => {
    expect(inferPhase('scout', makeState({ current_phase: 'analyze' }))).toBe('analyze');
  });

  it('scout at execute → execute (scout assists builder)', () => {
    expect(inferPhase('scout', makeState({ current_phase: 'execute' }))).toBe('execute');
  });

  it('strategist at plan → plan', () => {
    expect(inferPhase('strategist', makeState({ current_phase: 'plan' }))).toBe('plan');
  });

  it('planner at plan → plan', () => {
    expect(inferPhase('planner', makeState({ current_phase: 'plan' }))).toBe('plan');
  });

  it('builder at execute → execute', () => {
    expect(inferPhase('builder', makeState({ current_phase: 'execute' }))).toBe('execute');
  });

  it('reviewer at review → review', () => {
    expect(inferPhase('reviewer', makeState({ current_phase: 'review' }))).toBe('review');
  });

  it('shipper at ship → ship', () => {
    expect(inferPhase('shipper', makeState({ current_phase: 'ship' }))).toBe('ship');
  });

  // ─── Forward inference: agent not valid for current_phase → pick next valid ─

  it('scout dispatched at intent → analyze (next valid phase for scout)', () => {
    expect(inferPhase('scout', makeState({ current_phase: 'intent' }))).toBe('analyze');
  });

  it('strategist dispatched at analyze → plan', () => {
    expect(inferPhase('strategist', makeState({ current_phase: 'analyze' }))).toBe('plan');
  });

  it('builder dispatched at plan → execute', () => {
    expect(inferPhase('builder', makeState({ current_phase: 'plan' }))).toBe('execute');
  });

  it('reviewer dispatched at execute → review', () => {
    expect(inferPhase('reviewer', makeState({ current_phase: 'execute' }))).toBe('review');
  });

  it('shipper dispatched at review → ship', () => {
    expect(inferPhase('shipper', makeState({ current_phase: 'review' }))).toBe('ship');
  });

  // ─── Skip-path aware inference ────────────────────────────────────────────

  it('scout at intent with spec skipped (hotfix) → analyze', () => {
    expect(inferPhase('scout', makeState({
      current_phase: 'intent',
      change_type: 'hotfix',
    }))).toBe('analyze');
  });

  // ─── No valid phase → null ────────────────────────────────────────────────

  it('clarifier at execute → null (no valid phase ahead)', () => {
    expect(inferPhase('clarifier', makeState({ current_phase: 'execute' }))).toBeNull();
  });

  it('unknown agent → null', () => {
    expect(inferPhase('nonexistent', makeState())).toBeNull();
  });

  // ─── No state (first dispatch) → first valid phase for agent ──────────────

  it('clarifier with no state → intent', () => {
    expect(inferPhase('clarifier', null)).toBe('intent');
  });

  it('scout with no state → analyze', () => {
    expect(inferPhase('scout', null)).toBe('analyze');
  });

  it('builder with no state → execute', () => {
    expect(inferPhase('builder', null)).toBe('execute');
  });
});

describe('inferFeature', () => {
  it('returns active feature name when state exists', () => {
    const active = { state: makeState({ feature: 'auth-flow' }), featureDir: '/tmp/auth-flow' };
    expect(inferFeature(active, undefined)).toBe('auth-flow');
  });

  it('returns explicit feature when provided (overrides active)', () => {
    const active = { state: makeState({ feature: 'auth-flow' }), featureDir: '/tmp/auth-flow' };
    expect(inferFeature(active, 'new-feature')).toBe('new-feature');
  });

  it('returns explicit feature when no active feature exists', () => {
    expect(inferFeature(null, 'my-feature')).toBe('my-feature');
  });

  it('returns null when no active feature and no explicit feature', () => {
    expect(inferFeature(null, undefined)).toBeNull();
  });
});
