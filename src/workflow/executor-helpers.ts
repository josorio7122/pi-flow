/**
 * Executor helpers — handoff resolution and token accumulation.
 */

import type { AgentManager } from "../agents/manager.js";
import { listHandoffs } from "./store.js";
import type { PhaseDefinition, WorkflowState } from "./types.js";

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
