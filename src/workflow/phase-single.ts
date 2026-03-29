/**
 * Single phase — spawn one agent, wait for result, write handoff.
 */

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import type { AgentManager } from "../agents/manager.js";
import { trackAgentComplete, trackAgentStart } from "./executor-helpers.js";
import { buildPhasePrompt } from "./prompt-builder.js";
import { writeHandoff, writeState } from "./store.js";
import type { AgentHandoff, PhaseDefinition, WorkflowDefinition, WorkflowEvent, WorkflowState } from "./types.js";

export async function executeSinglePhase({
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
  const role = phase.role ?? "general-purpose";

  emitEvent({ type: "phase_start", phase: phase.name, ts: Date.now() });
  emitEvent({ type: "agent_start", role, agentId: "", phase: phase.name, ts: Date.now() });

  const basePrompt = buildPhasePrompt({ phase, definition, state, previousHandoff });
  const prompt = continuationContext ? `${continuationContext}\n\n${basePrompt}` : basePrompt;

  // Track agent as active before spawning (persisted for crash recovery)
  const placeholderId = `${phase.name}-pending`;
  trackAgentStart(state, placeholderId, role, phase.name);
  writeState(cwd, workflowId, state);

  const record = await manager.spawnAndWait({
    pi,
    ctx,
    type: role,
    prompt,
    options: { description: `${definition.name}: ${phase.name}` },
  });

  const duration = (record.completedAt ?? Date.now()) - record.startedAt;
  let tokens = 0;
  try {
    tokens = record.session?.getSessionStats().tokens.total ?? 0;
  } catch {
    /* session stats unavailable */
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

  const handoff: AgentHandoff = {
    agentId: record.id,
    role,
    phase: phase.name,
    summary: extractFirstLine(record.result ?? ""),
    findings: record.result ?? record.error ?? "No output.",
    filesAnalyzed: [],
    filesModified: [],
    toolsUsed: record.toolUses,
    turnsUsed: 0,
    duration,
    timestamp: Date.now(),
  };

  const handoffFile = writeHandoff(cwd, workflowId, handoff);
  emitEvent({ type: "handoff_written", from: role, handoffFile, ts: Date.now() });

  // Move agent from active to completed
  trackAgentComplete({
    state,
    agentId: record.id,
    role,
    phase: phase.name,
    handoffFile,
    duration,
    exitStatus: record.status === "error" ? "error" : "completed",
    error: record.error,
  });
  // Remove placeholder
  state.activeAgents = state.activeAgents.filter((a) => a.agentId !== placeholderId);
  writeState(cwd, workflowId, state);

  emitEvent({ type: "phase_complete", phase: phase.name, duration, tokens, ts: Date.now() });

  return { type: "complete", handoff };
}

function extractFirstLine(text: string) {
  const line = text.split("\n").find((l) => l.trim().length > 0);
  return line ? (line.length > 200 ? line.slice(0, 197) + "..." : line) : "No summary.";
}
