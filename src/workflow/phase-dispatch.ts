/**
 * Phase dispatch — routes to the correct phase handler based on mode.
 */

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import type { AgentManager } from "../agents/manager.js";
import { executeGatePhase } from "./phase-gate.js";
import { executeParallelPhase } from "./phase-parallel.js";
import { executeReviewLoop } from "./phase-review.js";
import { executeSinglePhase } from "./phase-single.js";
import type { AgentHandoff, PhaseDefinition, WorkflowDefinition, WorkflowEvent, WorkflowState } from "./types.js";

export async function dispatchPhase({
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
  signal?: AbortSignal | undefined;
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
        signal,
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
        signal,
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
        signal,
      });
    }
  }
}
