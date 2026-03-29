/**
 * Phase engine — state machine for workflow execution.
 * Tracks phase transitions, token usage, and the review-fix loop.
 *
 * Pure logic — no I/O, no agent spawning. Callers provide callbacks
 * for events and agent execution.
 *
 * Adapted from pi-coordination coordinate/pipeline.ts.
 */

import type {
  PhaseResult,
  PhaseStatus,
  ReviewIssue,
  TokenState,
  WorkflowDefinition,
  WorkflowEvent,
  WorkflowState,
} from "./types.js";

// ── State Initialization ─────────────────────────────────────────────

export function createWorkflowState({
  definition,
  description,
  workflowId,
}: {
  definition: WorkflowDefinition;
  description: string;
  workflowId: string;
}) {
  const phases: Record<string, PhaseResult> = {};
  for (const phase of definition.phases) {
    phases[phase.name] = {
      phase: phase.name,
      status: "pending",
      attempt: 0,
    };
  }

  const firstPhase = definition.phases[0];

  const state: WorkflowState = {
    id: workflowId,
    type: definition.name,
    description,
    definitionName: definition.name,
    currentPhase: firstPhase ? firstPhase.name : "",
    phases,
    reviewCycle: 0,
    maxReviewCycles: 3,
    tokens: createTokenState(definition.config.tokenLimit),
    activeAgents: [],
    completedAgents: [],
    countedAgentIds: [],
    startedAt: Date.now(),
  };

  return state;
}

export function createTokenState(limit: number) {
  return {
    total: 0,
    byPhase: {},
    limit,
    limitReached: false,
  };
}

// ── Phase Transitions ────────────────────────────────────────────────

export function updatePhaseStatus({
  state,
  phase,
  status,
  error,
  onEvent,
}: {
  state: WorkflowState;
  phase: string;
  status: PhaseStatus;
  error?: string | undefined;
  onEvent: (event: WorkflowEvent) => void;
}) {
  const now = Date.now();
  const result = state.phases[phase];
  if (!result) return;

  if (status === "running" && result.status !== "running") {
    result.startedAt = now;
    result.attempt++;
    state.currentPhase = phase;
    onEvent({ type: "phase_start", phase, ts: now });
  }

  if (status === "complete" || status === "failed") {
    result.completedAt = now;
    const duration = result.startedAt ? now - result.startedAt : 0;
    const tokens = state.tokens.byPhase[phase] ?? 0;
    onEvent({ type: "phase_complete", phase, duration, tokens, ts: now });
  }

  result.status = status;
  if (error !== undefined) {
    result.error = error;
  }
}

// ── Token Limit ──────────────────────────────────────────────────────

export function checkTokenLimit(tokens: TokenState) {
  if (tokens.limit <= 0) return false;
  if (tokens.total >= tokens.limit && !tokens.limitReached) {
    tokens.limitReached = true;
    return true;
  }
  return tokens.total >= tokens.limit;
}

// ── Stuck Detection ──────────────────────────────────────────────────

export function detectStuckIssues({
  currentIssues,
  reviewHistory,
  sameIssueLimit,
}: {
  currentIssues: readonly ReviewIssue[];
  reviewHistory: readonly (readonly ReviewIssue[])[];
  sameIssueLimit: number;
}) {
  if (reviewHistory.length < 2) return false;

  const previous = reviewHistory[reviewHistory.length - 2];
  if (!previous || previous.length === 0) return false;

  const currentDescs = new Set(currentIssues.map((i) => `${i.file}:${i.description}`));
  const previousDescs = new Set(previous.map((i) => `${i.file}:${i.description}`));

  let sameCount = 0;
  for (const desc of currentDescs) {
    if (previousDescs.has(desc)) sameCount++;
  }

  return sameCount >= Math.min(sameIssueLimit, currentIssues.length);
}
