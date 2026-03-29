/**
 * Executor helpers — handoff resolution, token accumulation, crash recovery, abort-aware spawn.
 */

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import type { AgentManager } from "../agents/manager.js";
import type { AgentRecord } from "../types.js";
import { buildContinuationPrompt } from "./recovery.js";
import { listHandoffs } from "./store.js";
import type { AgentHandoff, PhaseDefinition, WorkflowState } from "./types.js";

/**
 * Detect if a phase was interrupted (status still "running" from a previous session)
 * and build a continuation prompt with context from the previous attempt.
 * Returns undefined if the phase is starting fresh.
 */
export function buildInterruptedContext({
  state,
  phaseName,
  role,
  handoffs,
}: {
  state: WorkflowState;
  phaseName: string;
  role: string;
  handoffs: readonly AgentHandoff[];
}) {
  const phaseResult = state.phases[phaseName];
  if (!phaseResult || phaseResult.status !== "running") return undefined;

  // Phase was already running — this is a crash recovery re-entry
  const previousHandoff = findLatestHandoffForPhase(handoffs, phaseName);
  return buildContinuationPrompt({
    role,
    attemptNumber: phaseResult.attempt + 1,
    exitReason: "interrupted",
    previousHandoff,
  });
}

function findLatestHandoffForPhase(handoffs: readonly AgentHandoff[], phaseName: string) {
  for (let i = handoffs.length - 1; i >= 0; i--) {
    const h = handoffs[i];
    if (h && h.phase === phaseName) return h;
  }
  return undefined;
}

export function resolveContextHandoff({
  cwd,
  workflowId,
  phase,
}: {
  cwd: string;
  workflowId: string;
  phase: PhaseDefinition;
}) {
  if (!phase.contextFrom) return undefined;
  const handoffs = listHandoffs({ cwd, workflowId });
  for (let i = handoffs.length - 1; i >= 0; i--) {
    const h = handoffs[i];
    if (h && h.phase === phase.contextFrom) return h;
  }
  return undefined;
}

// ── Active Agent Tracking ────────────────────────────────────────────

export function trackAgentStart({
  state,
  agentId,
  role,
  phase,
  now = Date.now(),
}: {
  state: WorkflowState;
  agentId: string;
  role: string;
  phase: string;
  now?: number;
}) {
  state.activeAgents.push({ agentId, role, phase, startedAt: now });
}

export function trackAgentComplete({
  state,
  agentId,
  role,
  phase,
  handoffFile,
  duration,
  exitStatus,
  error,
}: {
  state: WorkflowState;
  agentId: string;
  role: string;
  phase: string;
  handoffFile: string;
  duration: number;
  exitStatus: "completed" | "error" | "aborted";
  error?: string | undefined;
}) {
  state.activeAgents = state.activeAgents.filter((a) => a.agentId !== agentId);
  state.completedAgents.push({ agentId, role, phase, handoffFile, duration, exitStatus, error });
}

// ── Token Accumulation ───────────────────────────────────────────────

export function accumulateTokens({
  state,
  phaseName,
  manager,
}: {
  state: WorkflowState;
  phaseName: string;
  manager: AgentManager;
}) {
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

// ── Abort-Aware Spawn ────────────────────────────────────────────────

export class WorkflowAbortError extends Error {
  constructor() {
    super("Workflow aborted");
    this.name = "WorkflowAbortError";
  }
}

/**
 * Spawn an agent and wait for completion, aborting if the signal fires.
 * Throws WorkflowAbortError if aborted before or during execution.
 */
export async function spawnWithAbort({
  manager,
  pi,
  ctx,
  type,
  prompt,
  description,
  signal,
}: {
  manager: AgentManager;
  pi: ExtensionAPI;
  ctx: ExtensionContext;
  type: string;
  prompt: string;
  description: string;
  signal?: AbortSignal | undefined;
}): Promise<AgentRecord> {
  if (signal?.aborted) throw new WorkflowAbortError();

  const id = manager.spawn({
    pi,
    ctx,
    type,
    prompt,
    options: { description, isBackground: false },
  });

  if (signal) {
    const onAbort = () => manager.abort(id);
    signal.addEventListener("abort", onAbort, { once: true });
    try {
      const record = manager.getRecord(id)!;
      await record.promise;
      return record;
    } finally {
      signal.removeEventListener("abort", onAbort);
    }
  }

  const record = manager.getRecord(id)!;
  await record.promise;
  return record;
}
