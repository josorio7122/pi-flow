/**
 * Generic workflow executor — reads phase mode and dispatches to handler.
 * The core orchestration loop that drives any workflow defined in .md files.
 */

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import type { AgentManager } from "../agents/manager.js";
import { accumulateTokens, buildInterruptedContext, resolveContextHandoff } from "./executor-helpers.js";
import { executeGatePhase } from "./phase-gate.js";
import { executeParallelPhase } from "./phase-parallel.js";
import { executeReviewLoop } from "./phase-review.js";
import { executeSinglePhase } from "./phase-single.js";
import { checkTokenLimit, updatePhaseStatus } from "./pipeline.js";
import { appendEvent, listHandoffs, writeState } from "./store.js";
import type { AgentHandoff, PhaseDefinition, WorkflowDefinition, WorkflowEvent, WorkflowState } from "./types.js";

export type PhaseOutcome =
  | { type: "complete" }
  | { type: "gate-waiting" }
  | { type: "stuck"; reason: string }
  | { type: "error"; error: string }
  | { type: "workflow-complete"; exitReason: string };

export async function executeCurrentPhase({
  definition,
  state,
  cwd,
  workflowId,
  pi,
  ctx,
  manager,
}: {
  definition: WorkflowDefinition;
  state: WorkflowState;
  cwd: string;
  workflowId: string;
  pi: ExtensionAPI;
  ctx: ExtensionContext;
  manager: AgentManager;
}): Promise<PhaseOutcome> {
  const phase = definition.phases.find((p) => p.name === state.currentPhase);
  if (!phase) return { type: "error", error: `Phase "${state.currentPhase}" not found in definition.` };

  const emitEvent = (event: WorkflowEvent) => appendEvent(cwd, workflowId, event);

  // Token budget check
  if (checkTokenLimit(state.tokens)) {
    state.exitReason = "token_limit";
    state.completedAt = Date.now();
    writeState(cwd, workflowId, state);
    emitEvent({
      type: "workflow_complete",
      exitReason: "token_limit",
      totalDuration: Date.now() - state.startedAt,
      totalTokens: state.tokens.total,
      ts: Date.now(),
    });
    return { type: "workflow-complete", exitReason: "token_limit" };
  }

  // Detect interrupted phase (crash recovery) before marking running
  const continuationContext = buildInterruptedContext({
    state,
    phaseName: phase.name,
    role: phase.role ?? "unknown",
    handoffs: listHandoffs(cwd, workflowId),
  });

  // Mark phase running
  updatePhaseStatus({ state, phase: phase.name, status: "running", onEvent: emitEvent });
  writeState(cwd, workflowId, state);

  // Resolve previous handoff (for contextFrom)
  const previousHandoff = resolveContextHandoff(cwd, workflowId, phase);

  try {
    const outcome = await dispatchPhase({
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
    });

    if (outcome.type === "gate-waiting") {
      updatePhaseStatus({ state, phase: phase.name, status: "gate-waiting", onEvent: emitEvent });
      writeState(cwd, workflowId, state);
      return { type: "gate-waiting" };
    }

    // Phase completed — update tokens and advance
    updatePhaseStatus({ state, phase: phase.name, status: "complete", onEvent: emitEvent });
    accumulateTokens(state, phase.name, manager);
    writeState(cwd, workflowId, state);

    return advanceToNextPhase({ definition, state, cwd, workflowId, pi, ctx, manager, emitEvent });
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    updatePhaseStatus({ state, phase: phase.name, status: "failed", error, onEvent: emitEvent });
    writeState(cwd, workflowId, state);
    emitEvent({ type: "agent_error", role: phase.role ?? "unknown", agentId: "", error, ts: Date.now() });
    return { type: "error", error };
  }
}

// ── Phase Dispatch ───────────────────────────────────────────────────

async function dispatchPhase({
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
}: {
  phase: PhaseDefinition;
  definition: WorkflowDefinition;
  state: WorkflowState;
  previousHandoff?: AgentHandoff | undefined;
  continuationContext?: string | undefined;
  cwd: string;
  workflowId: string;
  pi: ExtensionAPI;
  ctx: ExtensionContext;
  manager: AgentManager;
  emitEvent: (event: WorkflowEvent) => void;
}) {
  switch (phase.mode) {
    case "gate":
      return executeGatePhase({ phase, emitEvent });

    case "single": {
      const result = await executeSinglePhase({
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
      });
      return { type: result.type };
    }

    case "review-loop": {
      const targetHandoff = previousHandoff ?? {
        agentId: "",
        role: "unknown",
        phase: "unknown",
        summary: "",
        findings: state.description,
        filesAnalyzed: [],
        filesModified: [],
        toolsUsed: 0,
        turnsUsed: 0,
        duration: 0,
        timestamp: Date.now(),
      };
      return executeReviewLoop({
        phase,
        definition,
        state,
        targetHandoff,
        cwd,
        workflowId,
        pi,
        ctx,
        manager,
        emitEvent,
      });
    }

    case "parallel": {
      return executeParallelPhase({
        phase,
        definition,
        state,
        previousHandoff,
        cwd,
        workflowId,
        pi,
        ctx,
        manager,
        emitEvent,
      });
    }
  }
}

// ── Advancement ──────────────────────────────────────────────────────

function advanceToNextPhase({
  definition,
  state,
  cwd,
  workflowId,
  pi,
  ctx,
  manager,
  emitEvent,
}: {
  definition: WorkflowDefinition;
  state: WorkflowState;
  cwd: string;
  workflowId: string;
  pi: ExtensionAPI;
  ctx: ExtensionContext;
  manager: AgentManager;
  emitEvent: (event: WorkflowEvent) => void;
}): PhaseOutcome | Promise<PhaseOutcome> {
  const currentIndex = definition.phases.findIndex((p) => p.name === state.currentPhase);
  const nextIndex = currentIndex + 1;

  if (nextIndex >= definition.phases.length) {
    state.exitReason = "clean";
    state.completedAt = Date.now();
    writeState(cwd, workflowId, state);
    emitEvent({
      type: "workflow_complete",
      exitReason: "clean",
      totalDuration: Date.now() - state.startedAt,
      totalTokens: state.tokens.total,
      ts: Date.now(),
    });
    return { type: "workflow-complete", exitReason: "clean" };
  }

  const nextPhase = definition.phases[nextIndex];
  if (!nextPhase) return { type: "error", error: "Next phase not found." };

  state.currentPhase = nextPhase.name;
  writeState(cwd, workflowId, state);

  // Recurse — execute the next phase immediately
  return executeCurrentPhase({ definition, state, cwd, workflowId, pi, ctx, manager });
}
