/**
 * Phase dispatch — routes to the correct phase handler based on mode.
 * The tasks parameter allows the orchestrator to control parallelism.
 */

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import type { AgentManager } from "../agents/manager.js";
import type { AgentActivity } from "../ui/formatters.js";
import { executeParallelPhase } from "./phase-parallel.js";
import { executeReviewLoop } from "./phase-review.js";
import { executeSinglePhase as executeSingleAgent } from "./phase-single.js";
import { createTask, getTasks } from "./task-store.js";
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
  tasks,
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
  tasks?: readonly string[] | undefined;
}) {
  // If orchestrator provided multiple tasks, run as parallel regardless of mode
  if (tasks && tasks.length > 1) {
    const existing = getTasks({ cwd, workflowId });
    if (existing.length === 0) {
      for (const [i, title] of tasks.entries()) {
        createTask({ cwd, workflowId, input: { id: `task-${i + 1}`, title, dependsOn: [] } });
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

  // Single task provided — override phase description
  const effectivePhase = tasks?.[0] ? { ...phase, description: tasks[0] } : phase;

  switch (phase.mode) {
    case "single":
      return executeSingleAgent({
        phase: effectivePhase,
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

    case "parallel":
      return executeParallelPhase({
        phase: effectivePhase,
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
        phase: effectivePhase,
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

    case "gate":
      // Handled by executor before dispatch
      return { type: "gate-waiting" };
  }
}
