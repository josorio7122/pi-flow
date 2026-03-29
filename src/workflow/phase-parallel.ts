/**
 * Parallel phase — spawn agents for ready tasks, collect results.
 */

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import type { AgentManager } from "../agents/manager.js";
import { buildPhasePrompt } from "./prompt-builder.js";
import { writeHandoff } from "./store.js";
import { completeTask, getReadyTasks, getTasks } from "./task-store.js";
import type { AgentHandoff, PhaseDefinition, WorkflowDefinition, WorkflowEvent, WorkflowState } from "./types.js";

export async function executeParallelPhase({
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
}: {
  phase: PhaseDefinition;
  definition: WorkflowDefinition;
  state: WorkflowState;
  previousHandoff?: AgentHandoff | undefined;
  cwd: string;
  workflowId: string;
  pi: ExtensionAPI;
  ctx: ExtensionContext;
  manager: AgentManager;
  emitEvent: (event: WorkflowEvent) => void;
}) {
  const role = phase.role ?? "builder";

  emitEvent({ type: "phase_start", phase: phase.name, ts: Date.now() });

  let completedCount = 0;
  const allTasks = getTasks(cwd, workflowId);
  const totalTasks = allTasks.length;

  // Process tasks in waves until none are ready
  let readyTasks = getReadyTasks(cwd, workflowId);
  while (readyTasks.length > 0) {
    const promises = readyTasks.map(async (task) => {
      const taskPrompt = `## Task: ${task.title}\n\n${buildPhasePrompt({ phase, definition, state, previousHandoff })}`;

      emitEvent({ type: "agent_start", role, agentId: "", phase: phase.name, ts: Date.now() });

      const record = await manager.spawnAndWait({
        pi,
        ctx,
        type: role,
        prompt: taskPrompt,
        options: { description: `${definition.name}: ${task.title}` },
      });

      const duration = (record.completedAt ?? Date.now()) - record.startedAt;

      const handoff: AgentHandoff = {
        agentId: record.id,
        role,
        phase: phase.name,
        summary: task.title,
        findings: record.result ?? record.error ?? "No output.",
        filesAnalyzed: [],
        filesModified: [],
        toolsUsed: record.toolUses,
        turnsUsed: 0,
        duration,
        timestamp: Date.now(),
      };

      writeHandoff(cwd, workflowId, handoff);
      completeTask({ cwd, workflowId, taskId: task.id, summary: record.result ?? "Done" });
      completedCount++;

      emitEvent({
        type: "agent_complete",
        role,
        agentId: record.id,
        duration,
        toolUses: record.toolUses,
        exitStatus: record.status === "error" ? "error" : "completed",
        ts: Date.now(),
      });
    });

    await Promise.all(promises);
    readyTasks = getReadyTasks(cwd, workflowId);
  }

  emitEvent({ type: "phase_complete", phase: phase.name, duration: 0, tokens: 0, ts: Date.now() });

  return {
    type: completedCount >= totalTasks ? "complete" : "partial",
    completedTasks: completedCount,
    totalTasks,
  };
}
