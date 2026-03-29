/**
 * Parallel phase — spawn agents for ready tasks, collect results.
 */

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import type { AgentManager } from "../agents/manager.js";
import { trackAgentComplete, trackAgentStart } from "./executor-helpers.js";
import { buildPhasePrompt } from "./prompt-builder.js";
import { writeHandoff, writeState } from "./store.js";
import { blockTask, completeTask, createTask, getReadyTasks, getTasks } from "./task-store.js";
import type { AgentHandoff, PhaseDefinition, WorkflowDefinition, WorkflowEvent, WorkflowState } from "./types.js";

// ── Task Extraction ──────────────────────────────────────────────────

/** Strip markdown formatting: **bold**, `code`, [link](url) */
function stripMarkdown(text: string) {
  return text
    .replace(/\*\*(.+?)\*\*/g, "$1")
    .replace(/`(.+?)`/g, "$1")
    .replace(/\[(.+?)\]\(.+?\)/g, "$1")
    .trim();
}

/** Extract top-level bullet items from a handoff's findings as task inputs. */
export function extractTasksFromHandoff(handoff: AgentHandoff) {
  const lines = handoff.findings.split("\n");
  const tasks: { id: string; title: string }[] = [];
  let counter = 0;

  for (const line of lines) {
    // Skip indented bullets (sub-items)
    if (/^\s{2,}[-*]/.test(line)) continue;
    // Match top-level bullets: "- item" or "* item"
    const match = line.match(/^[-*]\s+(.+)/);
    if (!match?.[1]) continue;
    const title = stripMarkdown(match[1]);
    if (!title) continue;
    counter++;
    tasks.push({ id: `task-${counter}`, title });
  }

  return tasks;
}

// ── Phase Execution ──────────────────────────────────────────────────

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

  // Seed tasks from previous handoff if no tasks exist yet
  const existingTasks = getTasks({ cwd, workflowId });
  if (existingTasks.length === 0 && previousHandoff) {
    const taskInputs = extractTasksFromHandoff(previousHandoff);
    for (const input of taskInputs) {
      createTask({ cwd, workflowId, input: { id: input.id, title: input.title, dependsOn: [] } });
    }
  }

  let completedCount = 0;
  const allTasks = getTasks({ cwd, workflowId });
  const totalTasks = allTasks.length;

  // Process tasks in waves until none are ready
  let readyTasks = getReadyTasks({ cwd, workflowId });
  while (readyTasks.length > 0) {
    const promises = readyTasks.map(async (task) => {
      const taskPrompt = `## Task: ${task.title}\n\n${buildPhasePrompt({ phase, definition, state, previousHandoff })}`;

      emitEvent({ type: "agent_start", role, agentId: "", phase: phase.name, ts: Date.now() });
      trackAgentStart({ state, agentId: `task-${task.id}`, role: role, phase: phase.name });
      writeState({ cwd: cwd, workflowId: workflowId, state: state });

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

      const handoffFile = writeHandoff({ cwd: cwd, workflowId: workflowId, handoff: handoff });
      const exitStatus = record.status === "error" ? ("error" as const) : ("completed" as const);

      trackAgentComplete({
        state,
        agentId: record.id,
        role,
        phase: phase.name,
        handoffFile,
        duration,
        exitStatus,
        error: record.error,
      });
      state.activeAgents = state.activeAgents.filter((a) => a.agentId !== `task-${task.id}`);
      writeState({ cwd: cwd, workflowId: workflowId, state: state });

      if (record.status === "error") {
        blockTask({ cwd, workflowId, taskId: task.id, reason: record.error ?? "Agent error" });
      } else {
        completeTask({ cwd, workflowId, taskId: task.id, summary: record.result ?? "Done" });
        completedCount++;
      }

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
    readyTasks = getReadyTasks({ cwd, workflowId });
  }

  emitEvent({ type: "phase_complete", phase: phase.name, duration: 0, tokens: 0, ts: Date.now() });

  return {
    type: completedCount >= totalTasks ? "complete" : "partial",
    completedTasks: completedCount,
    totalTasks,
  };
}
