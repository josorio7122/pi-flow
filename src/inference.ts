/**
 * Phase inference — maps agent name + current state to the correct phase.
 *
 * Eliminates the need for the coordinator to specify `phase` in dispatch_flow.
 * The extension knows which phases each agent can operate in, and picks the
 * right one based on the current workflow state.
 */

import type { FlowState, Phase } from './types.js';
import { getEffectivePipeline } from './transitions.js';

// ─── Agent → Phase mapping ───────────────────────────────────────────────────

/**
 * Which phases each agent is valid for, in pipeline order.
 * When an agent is dispatched, we pick the FIRST phase from this list
 * that is >= current_phase in the effective pipeline.
 */
const AGENT_PHASES: Record<string, Phase[]> = {
  clarifier: ['intent', 'spec'],
  scout: ['analyze', 'execute'],
  strategist: ['plan'],
  planner: ['plan'],
  builder: ['execute'],
  sentinel: ['execute'],
  reviewer: ['review'],
  shipper: ['ship'],
};

// ─── inferPhase ──────────────────────────────────────────────────────────────

/**
 * Given an agent name and the current flow state, infer which phase
 * this dispatch should target.
 *
 * Rules:
 * 1. If the agent is valid for the current_phase → use current_phase
 * 2. Otherwise, find the first phase in the pipeline AFTER current_phase
 *    that the agent is valid for
 * 3. If no state exists (first dispatch), use the agent's first valid phase
 * 4. If no valid phase can be found, return null
 */
export function inferPhase(agentName: string, state: FlowState | null): Phase | null {
  const validPhases = AGENT_PHASES[agentName];
  if (!validPhases || validPhases.length === 0) return null;

  // No state — first dispatch, use agent's first valid phase
  if (!state) return validPhases[0];

  const currentPhase = state.current_phase;
  const pipeline = getEffectivePipeline(state.change_type, state.skipped_phases);

  // If agent is valid for current_phase, use it
  if (validPhases.includes(currentPhase)) return currentPhase;

  // Find current_phase position in pipeline
  const currentIdx = pipeline.indexOf(currentPhase);
  if (currentIdx === -1) return validPhases[0]; // fallback

  // Find the first valid phase for this agent that comes AFTER current_phase in the pipeline
  for (let i = currentIdx + 1; i < pipeline.length; i++) {
    if (validPhases.includes(pipeline[i])) return pipeline[i];
  }

  // No valid phase found ahead in the pipeline
  return null;
}

// ─── inferFeature ────────────────────────────────────────────────────────────

/**
 * Determines the feature name for a dispatch.
 *
 * Priority:
 * 1. Explicit feature param (if provided) — for starting new features
 * 2. Active feature from state — for continuing work
 * 3. null — no feature could be determined
 */
export function inferFeature(
  activeFeature: { state: FlowState; featureDir: string } | null,
  explicitFeature: string | undefined,
): string | null {
  if (explicitFeature) return explicitFeature;
  if (activeFeature) return activeFeature.state.feature;
  return null;
}
