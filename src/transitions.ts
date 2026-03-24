import type { ChangeType, Phase } from './types.js';

// ─── Skip path table (architecture.md §2) ────────────────────────────────────

const SKIP_PATHS: Record<ChangeType, Phase[]> = {
  feature: ['intent', 'spec', 'analyze', 'plan', 'execute', 'review', 'ship'],
  refactor: ['intent', 'analyze', 'plan', 'execute', 'review', 'ship'],
  hotfix: ['intent', 'analyze', 'execute', 'review', 'ship'],
  docs: ['intent', 'execute', 'ship'],
  config: ['intent', 'analyze', 'execute', 'ship'],
  research: ['intent', 'analyze'],
};

// Phases where the gate requires human approval before entry.
// analyze is gated by spec.md approval, execute is gated by design.md approval.
const APPROVAL_GATES = new Set<Phase>(['analyze', 'execute']);

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Returns the ordered phase pipeline for a given change type,
 * excluding any manually skipped phases.
 */
export function getEffectivePipeline(changeType: ChangeType, skippedPhases: Phase[]): Phase[] {
  const base = SKIP_PATHS[changeType];
  if (skippedPhases.length === 0) return base;
  const skip = new Set(skippedPhases);
  return base.filter((p) => !skip.has(p));
}

/**
 * Returns the next phase after `currentPhase` in the effective pipeline,
 * or `null` if `currentPhase` is terminal or not in the pipeline.
 */
export function getNextPhase(
  changeType: ChangeType,
  skippedPhases: Phase[],
  currentPhase: Phase,
): Phase | null {
  const pipeline = getEffectivePipeline(changeType, skippedPhases);
  const idx = pipeline.indexOf(currentPhase);
  if (idx === -1 || idx === pipeline.length - 1) return null;
  return pipeline[idx + 1];
}

/**
 * Returns true if `currentPhase` is the last phase in the effective pipeline.
 * Returns false if the phase is not in the pipeline at all.
 */
export function isTerminalPhase(
  changeType: ChangeType,
  skippedPhases: Phase[],
  currentPhase: Phase,
): boolean {
  const pipeline = getEffectivePipeline(changeType, skippedPhases);
  if (pipeline.length === 0) return false;
  return pipeline[pipeline.length - 1] === currentPhase;
}

/**
 * Returns true if entering this phase requires human approval of a prior artifact.
 * - `analyze` requires spec.md approval
 * - `execute` requires design.md approval
 */
export function phaseRequiresApproval(phase: Phase): boolean {
  return APPROVAL_GATES.has(phase);
}
