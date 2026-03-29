/**
 * Executor helpers — handoff resolution, token accumulation, crash recovery.
 */

import type { AgentManager } from "../agents/manager.js";
import { buildContinuationPrompt } from "./recovery.js";
import { listHandoffs } from "./store.js";
import type { AgentHandoff, PhaseDefinition, WorkflowState } from "./types.js";

/**
 * Detect if a phase was interrupted (status still "running" from a previous session)
 * and build a continuation prompt with context from the previous attempt.
 * Returns undefined if the phase is starting fresh.
 */
export function buildInterruptedContext({
  state,
  phaseName,
  role,
  handoffs,
}: {
  state: WorkflowState;
  phaseName: string;
  role: string;
  handoffs: readonly AgentHandoff[];
}) {
  const phaseResult = state.phases[phaseName];
  if (!phaseResult || phaseResult.status !== "running") return undefined;

  // Phase was already running — this is a crash recovery re-entry
  const previousHandoff = findLatestHandoffForPhase(handoffs, phaseName);
  return buildContinuationPrompt({
    role,
    attemptNumber: phaseResult.attempt + 1,
    exitReason: "interrupted",
    previousHandoff,
  });
}

function findLatestHandoffForPhase(handoffs: readonly AgentHandoff[], phaseName: string) {
  for (let i = handoffs.length - 1; i >= 0; i--) {
    const h = handoffs[i];
    if (h && h.phase === phaseName) return h;
  }
  return undefined;
}

export function resolveContextHandoff(cwd: string, workflowId: string, phase: PhaseDefinition) {
  if (!phase.contextFrom) return undefined;
  const handoffs = listHandoffs(cwd, workflowId);
  for (let i = handoffs.length - 1; i >= 0; i--) {
    const h = handoffs[i];
    if (h && h.phase === phase.contextFrom) return h;
  }
  return undefined;
}

export function accumulateTokens(state: WorkflowState, phaseName: string, manager: AgentManager) {
  for (const agent of manager.listAgents()) {
    if (!agent.completedAt || !agent.session) continue;
    if (state.countedAgentIds.includes(agent.id)) continue;
    try {
      const tokens = agent.session.getSessionStats().tokens.total;
      state.tokens.total += tokens;
      state.tokens.byPhase[phaseName] = (state.tokens.byPhase[phaseName] ?? 0) + tokens;
      state.countedAgentIds.push(agent.id);
    } catch {
      /* stats unavailable */
    }
  }
}
