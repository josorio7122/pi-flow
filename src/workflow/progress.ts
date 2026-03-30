/**
 * Progress rendering — widget lines, status bar text, format helpers.
 * Pure functions — no I/O, no side effects.
 */

import type { AgentRecord } from "../types.js";
import type { PhaseStatus, WorkflowDefinition, WorkflowState } from "./types.js";

// ── Format Helpers ───────────────────────────────────────────────────

const STATUS_ICONS: Record<string, string> = {
  complete: "✓",
  running: "●",
  pending: "○",
  failed: "✗",
  skipped: "—",
  "gate-waiting": "⏸",
};

export function getStatusIcon(status: string) {
  return STATUS_ICONS[status] ?? "?";
}

export function formatDuration(ms: number) {
  const totalSeconds = Math.floor(ms / 1000);
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}m${seconds.toString().padStart(2, "0")}s`;
}

export function formatTokens(tokens: number) {
  if (tokens < 1000) return `${tokens}`;
  return `${(tokens / 1000).toFixed(1)}K`;
}

// ── Widget Lines ─────────────────────────────────────────────────────

function formatAgentLine(agent: AgentRecord) {
  const elapsed = formatDuration(Date.now() - agent.startedAt);
  const parts: string[] = [];
  if (agent.turnCount > 0) parts.push(`⟳${agent.turnCount}`);
  if (agent.toolUses > 0) parts.push(`${agent.toolUses} tools`);
  try {
    const tokens = agent.session?.getSessionStats().tokens.total;
    if (tokens) parts.push(formatTokens(tokens));
  } catch {
    /* */
  }
  parts.push(elapsed);
  return `    ${agent.type} · ${parts.join(" · ")}`;
}

export function buildProgressLines({
  state,
  definition,
  runningAgents,
}: {
  state: WorkflowState;
  definition: WorkflowDefinition;
  runningAgents?: readonly AgentRecord[] | undefined;
}) {
  const lines: string[] = [];

  lines.push(`Flow: ${state.type} — ${truncate(state.description, 60)}`);

  for (const p of definition.phases) {
    const result = state.phases[p.name];
    const status: PhaseStatus = result?.status ?? "pending";
    const icon = getStatusIcon(status);
    const duration = result?.completedAt
      ? ` (${formatDuration(result.completedAt - (result.startedAt ?? state.startedAt))})`
      : "";
    lines.push(`  ${icon} ${p.name}${duration}`);

    if (status === "running" && runningAgents) {
      for (const agent of runningAgents) lines.push(formatAgentLine(agent));
    }
  }

  return lines;
}

// ── Status Bar Text ──────────────────────────────────────────────────

export function buildStatusText(state: WorkflowState) {
  const completed = Object.values(state.phases).filter((p) => p.status === "complete").length;
  const total = Object.keys(state.phases).length;
  const tokens = formatTokens(state.tokens.total);
  const elapsed = formatDuration(Date.now() - state.startedAt);
  return `[flow] ${state.currentPhase} ● ${completed}/${total} | ${tokens} tokens | ${elapsed}`;
}

// ── Helpers ──────────────────────────────────────────────────────────

function truncate(text: string, maxLen: number) {
  if (text.length <= maxLen) return text;
  return `${text.slice(0, maxLen - 3)}...`;
}
