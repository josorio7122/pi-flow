import { describe, it, expect } from 'vitest';
import {
  getEffectivePipeline,
  getNextPhase,
  isTerminalPhase,
  phaseRequiresApproval,
} from './transitions.js';

// ─── getEffectivePipeline ─────────────────────────────────────────────────────

describe('getEffectivePipeline', () => {
  it('returns full pipeline for feature', () => {
    expect(getEffectivePipeline('feature', [])).toEqual([
      'intent',
      'spec',
      'analyze',
      'plan',
      'execute',
      'review',
      'ship',
    ]);
  });

  it('returns pipeline for refactor (no spec)', () => {
    expect(getEffectivePipeline('refactor', [])).toEqual([
      'intent',
      'analyze',
      'plan',
      'execute',
      'review',
      'ship',
    ]);
  });

  it('returns pipeline for hotfix (no spec)', () => {
    expect(getEffectivePipeline('hotfix', [])).toEqual([
      'intent',
      'analyze',
      'plan',
      'execute',
      'review',
      'ship',
    ]);
  });

  it('returns pipeline for docs (no spec, no analyze, no review)', () => {
    expect(getEffectivePipeline('docs', [])).toEqual([
      'intent',
      'plan',
      'execute',
      'ship',
    ]);
  });

  it('returns pipeline for config (no spec, no review)', () => {
    expect(getEffectivePipeline('config', [])).toEqual([
      'intent',
      'analyze',
      'plan',
      'execute',
      'ship',
    ]);
  });

  it('returns pipeline for research (intent → analyze only)', () => {
    expect(getEffectivePipeline('research', [])).toEqual(['intent', 'analyze']);
  });

  it('excludes manually skipped phases', () => {
    expect(getEffectivePipeline('feature', ['analyze', 'review'])).toEqual([
      'intent',
      'spec',
      'plan',
      'execute',
      'ship',
    ]);
  });

  it('skipping a phase not in the base pipeline is a no-op', () => {
    expect(getEffectivePipeline('docs', ['analyze', 'review'])).toEqual([
      'intent',
      'plan',
      'execute',
      'ship',
    ]);
  });

  it('returns empty array when all phases are skipped', () => {
    expect(getEffectivePipeline('docs', ['intent', 'plan', 'execute', 'ship'])).toEqual([]);
  });

  it('returns the base array by reference when no phases are skipped', () => {
    const result1 = getEffectivePipeline('feature', []);
    const result2 = getEffectivePipeline('feature', []);
    expect(result1).toBe(result2);
  });
});

// ─── getNextPhase ─────────────────────────────────────────────────────────────

describe('getNextPhase', () => {
  it('advances from intent to spec for feature', () => {
    expect(getNextPhase('feature', [], 'intent')).toBe('spec');
  });

  it('advances from spec to analyze for feature', () => {
    expect(getNextPhase('feature', [], 'spec')).toBe('analyze');
  });

  it('advances from execute to review for feature', () => {
    expect(getNextPhase('feature', [], 'execute')).toBe('review');
  });

  it('advances from review to ship for feature', () => {
    expect(getNextPhase('feature', [], 'review')).toBe('ship');
  });

  it('returns null at terminal phase (ship)', () => {
    expect(getNextPhase('feature', [], 'ship')).toBeNull();
  });

  it('advances from intent to analyze for refactor (skips spec)', () => {
    expect(getNextPhase('refactor', [], 'intent')).toBe('analyze');
  });

  it('advances from intent to analyze for hotfix', () => {
    expect(getNextPhase('hotfix', [], 'intent')).toBe('analyze');
  });

  it('advances from analyze to plan for hotfix', () => {
    expect(getNextPhase('hotfix', [], 'analyze')).toBe('plan');
  });

  it('advances from intent to plan for docs', () => {
    expect(getNextPhase('docs', [], 'intent')).toBe('plan');
  });

  it('advances from execute to ship for docs (skips review)', () => {
    expect(getNextPhase('docs', [], 'execute')).toBe('ship');
  });

  it('returns null at terminal phase for research (analyze)', () => {
    expect(getNextPhase('research', [], 'analyze')).toBeNull();
  });

  it('respects manually skipped phases', () => {
    // feature with review skipped: execute → ship
    expect(getNextPhase('feature', ['review'], 'execute')).toBe('ship');
  });

  it('returns null if current phase is not in pipeline', () => {
    // docs pipeline has no analyze phase
    expect(getNextPhase('docs', [], 'analyze')).toBeNull();
  });

  it('returns null when all phases are skipped', () => {
    expect(getNextPhase('docs', ['intent', 'execute', 'ship'], 'intent')).toBeNull();
  });

  it('advances through each phase of config pipeline', () => {
    expect(getNextPhase('config', [], 'intent')).toBe('analyze');
    expect(getNextPhase('config', [], 'analyze')).toBe('plan');
    expect(getNextPhase('config', [], 'plan')).toBe('execute');
    expect(getNextPhase('config', [], 'execute')).toBe('ship');
    expect(getNextPhase('config', [], 'ship')).toBeNull();
  });
});

// ─── isTerminalPhase ──────────────────────────────────────────────────────────

describe('isTerminalPhase', () => {
  it('ship is terminal for feature', () => {
    expect(isTerminalPhase('feature', [], 'ship')).toBe(true);
  });

  it('execute is not terminal for feature', () => {
    expect(isTerminalPhase('feature', [], 'execute')).toBe(false);
  });

  it('analyze is terminal for research', () => {
    expect(isTerminalPhase('research', [], 'analyze')).toBe(true);
  });

  it('intent is not terminal for research', () => {
    expect(isTerminalPhase('research', [], 'intent')).toBe(false);
  });

  it('ship is terminal for docs', () => {
    expect(isTerminalPhase('docs', [], 'ship')).toBe(true);
  });

  it('phase not in pipeline returns false', () => {
    expect(isTerminalPhase('docs', [], 'review')).toBe(false);
  });

  it('returns false when all phases are skipped (empty pipeline)', () => {
    expect(isTerminalPhase('docs', ['intent', 'plan', 'execute', 'ship'], 'ship')).toBe(false);
  });
});

// ─── phaseRequiresApproval ────────────────────────────────────────────────────

describe('phaseRequiresApproval', () => {
  it('analyze requires approval (spec must be approved)', () => {
    expect(phaseRequiresApproval('analyze')).toBe(true);
  });

  it('execute requires approval (design must be approved)', () => {
    expect(phaseRequiresApproval('execute')).toBe(true);
  });

  it('intent does not require approval', () => {
    expect(phaseRequiresApproval('intent')).toBe(false);
  });

  it('spec does not require approval', () => {
    expect(phaseRequiresApproval('spec')).toBe(false);
  });

  it('plan does not require approval', () => {
    expect(phaseRequiresApproval('plan')).toBe(false);
  });

  it('review does not require approval', () => {
    expect(phaseRequiresApproval('review')).toBe(false);
  });

  it('ship does not require approval', () => {
    expect(phaseRequiresApproval('ship')).toBe(false);
  });
});
