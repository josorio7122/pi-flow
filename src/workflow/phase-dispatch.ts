/**
 * Phase dispatch — routes to the correct phase handler based on mode.
 */

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import type { AgentManager } from "../agents/manager.js";
import type { AgentActivity } from "../ui/formatters.js";
import { executeAutoPhase } from "./phase-auto.js";
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
  agentActivity,
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
  agentActivity?: Map<string, AgentActivity> | undefined;
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
        agentActivity,
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
        agentActivity,
      });
    }

    case "auto": {
      const planned = state.plannedTasks?.[phase.name];
      const autoResult = executeAutoPhase({ tasks: planned });
      if (autoResult.type === "needs-planning") {
        return {
          type: "needs-planning",
          phase: phase.name,
          role: phase.role ?? "general-purpose",
          description: phase.description,
        };
      }
      // Single task → run as single phase
      if (autoResult.tasks.length === 1) {
        return executeSinglePhase({
          phase: { ...phase, description: autoResult.tasks[0]! },
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
        }).then((r) => ({ type: r.type }));
      }
      // Multiple tasks → run as parallel
      // Seed tasks into the task store, then delegate to parallel handler
      const { createTask, getTasks } = await import("./task-store.js");
      const existing = getTasks({ cwd, workflowId });
      if (existing.length === 0) {
        for (const [i, title] of autoResult.tasks.entries()) {
          createTask({ cwd, workflowId, input: { id: `auto-${i + 1}`, title, dependsOn: [] } });
        }
      }
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
        agentActivity,
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
        agentActivity,
      });
    }
  }
}
