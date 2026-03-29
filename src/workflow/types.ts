/**
 * Workflow type definitions — the vocabulary shared by all workflow tooling.
 */

// ── Workflow Definition (loaded from .md files) ──────────────────────

export interface WorkflowDefinition {
  name: string;
  description: string;
  triggers: string[];
  phases: readonly PhaseDefinition[];
  config: WorkflowConfig;
  orchestratorInstructions: string;
  source: "builtin" | "global" | "project";
}

export type PhaseMode = "single" | "parallel" | "gate" | "review-loop";

export interface PhaseDefinition {
  name: string;
  role?: string | undefined;
  mode: PhaseMode;
  description: string;
  contextFrom?: string | undefined;
  fixRole?: string | undefined;
  maxCycles?: number | undefined;
}

export interface WorkflowConfig {
  tokenLimit: number;
}

// ── Workflow Runtime State (persisted to state.json) ─────────────────

export type PhaseStatus = "pending" | "running" | "complete" | "failed" | "skipped" | "gate-waiting";

export interface PhaseResult {
  phase: string;
  status: PhaseStatus;
  startedAt?: number | undefined;
  completedAt?: number | undefined;
  error?: string | undefined;
  attempt: number;
}

export type ExitReason = "clean" | "stuck" | "max_cycles" | "token_limit" | "user_abort";

export interface TokenState {
  total: number;
  byPhase: Record<string, number>;
  limit: number;
  limitReached: boolean;
}

export interface ActiveAgent {
  agentId: string;
  role: string;
  phase: string;
  startedAt: number;
}

export interface CompletedAgent {
  agentId: string;
  role: string;
  phase: string;
  handoffFile: string;
  duration: number;
  exitStatus: "completed" | "error" | "aborted";
  error?: string | undefined;
}

export interface WorkflowState {
  id: string;
  type: string;
  description: string;
  definitionName: string;
  currentPhase: string;
  phases: Record<string, PhaseResult>;
  reviewCycle: number;
  exitReason?: ExitReason | undefined;
  tokens: TokenState;
  activeAgents: ActiveAgent[];
  completedAgents: CompletedAgent[];
  /** Agent IDs whose tokens have already been counted — prevents double-counting across phases. */
  countedAgentIds: string[];
  startedAt: number;
  completedAt?: number | undefined;
}

// ── Agent Handoff (persisted to handoffs/*.json) ─────────────────────

export interface AgentHandoff {
  agentId: string;
  role: string;
  phase: string;
  summary: string;
  findings: string;
  filesAnalyzed: readonly string[];
  filesModified: readonly string[];
  toolsUsed: number;
  verdict?: ReviewVerdict | undefined;
  issues?: readonly ReviewIssue[] | undefined;
  duration: number;
  timestamp: number;
}

// ── Review ───────────────────────────────────────────────────────────

export type ReviewVerdict = "SHIP" | "NEEDS_WORK" | "MAJOR_RETHINK";

export interface ReviewIssue {
  file: string;
  line?: number | undefined;
  severity: "error" | "warning" | "suggestion";
  category: string;
  description: string;
  suggestedFix?: string | undefined;
}

export interface ParsedReview {
  verdict: ReviewVerdict;
  summary: string;
  issues: string[];
  suggestions: string[];
}

// ── Events (persisted to events.jsonl) ───────────────────────────────

export type WorkflowEvent =
  | { type: "workflow_start"; workflowType: string; description: string; ts: number }
  | { type: "workflow_complete"; exitReason: ExitReason; totalDuration: number; totalTokens: number; ts: number }
  | { type: "workflow_resumed"; previousPhase: string; ts: number }
  | { type: "phase_start"; phase: string; ts: number }
  | { type: "phase_complete"; phase: string; duration: number; tokens: number; ts: number }
  | { type: "agent_start"; role: string; agentId: string; phase: string; ts: number }
  | {
      type: "agent_complete";
      role: string;
      agentId: string;
      duration: number;
      toolUses: number;
      exitStatus: string;
      ts: number;
    }
  | { type: "agent_error"; role: string; agentId: string; error: string; ts: number }
  | { type: "handoff_written"; from: string; handoffFile: string; ts: number }
  | { type: "approval"; phase: string; decision: "approved" | "rejected"; ts: number }
  | { type: "review_verdict"; verdict: ReviewVerdict; issueCount: number; cycle: number; ts: number }
  | { type: "token_update"; total: number; phase: string; delta: number; ts: number };

// ── Tasks (persisted to tasks/*.json, W4 only) ──────────────────────

export type TaskStatus = "todo" | "in_progress" | "done" | "blocked";

export interface Task {
  id: string;
  title: string;
  status: TaskStatus;
  dependsOn: readonly string[];
  createdAt: string;
  updatedAt: string;
  summary?: string | undefined;
  blockedReason?: string | undefined;
  attemptCount: number;
}
