/**
 * Single phase — spawn one agent, wait for result, write handoff.
 */

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import type { AgentManager } from "../agents/manager.js";
import { buildPhasePrompt } from "./prompt-builder.js";
import { writeHandoff } from "./store.js";
import type { AgentHandoff, PhaseDefinition, WorkflowDefinition, WorkflowEvent, WorkflowState } from "./types.js";

export async function executeSinglePhase({
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
  const role = phase.role ?? "general-purpose";

  emitEvent({ type: "phase_start", phase: phase.name, ts: Date.now() });
  emitEvent({ type: "agent_start", role, agentId: "", phase: phase.name, ts: Date.now() });

  const prompt = buildPhasePrompt({ phase, definition, state, previousHandoff });

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

  writeHandoff(cwd, workflowId, handoff);
  emitEvent({ type: "handoff_written", from: role, handoffFile: `${phase.name}.json`, ts: Date.now() });
  emitEvent({ type: "phase_complete", phase: phase.name, duration, tokens, ts: Date.now() });

  return { type: "complete", handoff };
}

function extractFirstLine(text: string) {
  const line = text.split("\n").find((l) => l.trim().length > 0);
  return line ? (line.length > 200 ? line.slice(0, 197) + "..." : line) : "No summary.";
}
