/**
 * Progress rendering — status bar text and format helpers.
 * Pure functions — no I/O, no side effects.
 */

import type { WorkflowState } from "./types.js";

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

// ── Status Bar Text ──────────────────────────────────────────────────

export function buildStatusText(state: WorkflowState, liveTokens?: number | undefined) {
  const completed = Object.values(state.phases).filter((p) => p.status === "complete").length;
  const total = Object.keys(state.phases).length;
  const tokenCount = liveTokens ?? state.tokens.total;
  const tokens = formatTokens(tokenCount);
  const elapsed = formatDuration(Date.now() - state.startedAt);
  return `[flow] ${state.currentPhase} ● ${completed}/${total} | ${tokens} tokens | ${elapsed}`;
}
