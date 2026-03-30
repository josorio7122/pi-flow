/**
 * Workflow executor — runs a single phase and returns the result.
 * No auto-advancement. The orchestrator (LLM) drives phase progression.
 */

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import type { AgentManager } from "../agents/manager.js";
import type { AgentActivity } from "../ui/formatters.js";
import {
  accumulateTokens,
  buildInterruptedContext,
  resolveContextHandoff,
  WorkflowAbortError,
} from "./executor-helpers.js";
import { dispatchPhase } from "./phase-dispatch.js";
import { checkTokenLimit, updatePhaseStatus } from "./pipeline.js";
import { appendEvent, listHandoffs, writeState } from "./store.js";
import type { WorkflowDefinition, WorkflowEvent, WorkflowState } from "./types.js";

export type PhaseOutcome =
  | { type: "phase-complete" }
  | { type: "gate-waiting" }
  | { type: "workflow-complete"; exitReason: string }
  | { type: "error"; error: string };

export async function executeSinglePhase({
  definition,
  state,
  cwd,
  workflowId,
  pi,
  ctx,
  manager,
  signal,
  agentActivity,
  tasks,
}: {
  definition: WorkflowDefinition;
  state: WorkflowState;
  cwd: string;
  workflowId: string;
  pi: ExtensionAPI;
  ctx: ExtensionContext;
  manager: AgentManager;
  signal?: AbortSignal | undefined;
  agentActivity?: Map<string, AgentActivity> | undefined;
  tasks?: readonly string[] | undefined;
}): Promise<PhaseOutcome> {
  if (signal?.aborted) return { type: "workflow-complete", exitReason: "user_abort" };

  const phase = definition.phases.find((p) => p.name === state.currentPhase);
  if (!phase) return { type: "error", error: `Phase "${state.currentPhase}" not found in definition.` };

  const emitEvent = (event: WorkflowEvent) => appendEvent({ cwd, workflowId, event });

  if (checkTokenLimit(state.tokens)) {
    state.exitReason = "token_limit";
    state.completedAt = Date.now();
    writeState({ cwd, workflowId, state });
    return { type: "workflow-complete", exitReason: "token_limit" };
  }

  // Gate phases return immediately
  if (phase.mode === "gate") {
    updatePhaseStatus({ state, phase: phase.name, status: "gate-waiting", onEvent: emitEvent });
    writeState({ cwd, workflowId, state });
    return { type: "gate-waiting" };
  }

  const continuationContext = buildInterruptedContext({
    state,
    phaseName: phase.name,
    role: phase.role ?? "unknown",
    handoffs: listHandoffs({ cwd, workflowId }),
  });

  updatePhaseStatus({ state, phase: phase.name, status: "running", onEvent: emitEvent });
  writeState({ cwd, workflowId, state });

  const previousHandoff = resolveContextHandoff({ cwd, workflowId, phase });

  try {
    await dispatchPhase({
      phase,
      definition,
      state,
      previousHandoff,
      continuationContext,
      cwd,
      workflowId,
      pi,
      ctx,
      manager,
      emitEvent,
      signal,
      agentActivity,
      tasks,
    });

    updatePhaseStatus({ state, phase: phase.name, status: "complete", onEvent: emitEvent });
    accumulateTokens({ state, phaseName: phase.name, manager });

    // Advance to next phase (or complete workflow)
    const currentIndex = definition.phases.findIndex((p) => p.name === state.currentPhase);
    const nextPhase = definition.phases[currentIndex + 1];
    if (nextPhase) {
      state.currentPhase = nextPhase.name;
    } else {
      state.exitReason = "clean";
      state.completedAt = Date.now();
    }
    writeState({ cwd, workflowId, state });

    return nextPhase ? { type: "phase-complete" } : { type: "workflow-complete", exitReason: "clean" };
  } catch (err) {
    if (err instanceof WorkflowAbortError) {
      state.exitReason = "user_abort";
      state.completedAt = Date.now();
      writeState({ cwd, workflowId, state });
      return { type: "workflow-complete", exitReason: "user_abort" };
    }
    const error = err instanceof Error ? err.message : String(err);
    updatePhaseStatus({ state, phase: phase.name, status: "failed", error, onEvent: emitEvent });
    writeState({ cwd, workflowId, state });
    return { type: "error", error };
  }
}
