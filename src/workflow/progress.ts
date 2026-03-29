/**
 * Progress rendering — widget lines, status bar text, format helpers.
 *
 * Pure functions — no I/O, no side effects.
 * Format helpers from pi-coordination coordinate/render-utils.ts.
 * Widget pattern from pi-manage-todo-list ui/todo-widget.ts.
 */

import type { PhaseStatus, WorkflowDefinition, WorkflowState } from "./types.js";

// ── Format Helpers (from pi-coordination render-utils.ts) ────────────

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

export function buildProgressLines({ state, definition }: { state: WorkflowState; definition: WorkflowDefinition }) {
  const lines: string[] = [];

  const header = `Flow: ${state.type} — ${truncate(state.description, 50)}`;
  lines.push(header);

  const phaseLine = definition.phases
    .map((p) => {
      const result = state.phases[p.name];
      const status: PhaseStatus = result?.status ?? "pending";
      const icon = getStatusIcon(status);
      return `${icon} ${p.name}`;
    })
    .join("    ");
  lines.push(`  ${phaseLine}`);

  if (state.activeAgents.length > 0) {
    for (const agent of state.activeAgents) {
      const elapsed = formatDuration(Date.now() - agent.startedAt);
      lines.push(`  ${agent.role} working... (${elapsed})`);
    }
  }

  return lines;
}

// ── Status Bar Text ──────────────────────────────────────────────────

export function buildStatusText(state: WorkflowState) {
  const phaseNames = Object.keys(state.phases);
  const completed = Object.values(state.phases).filter((p) => p.status === "complete").length;
  const total = phaseNames.length;
  const tokens = formatTokens(state.tokens.total);
  const elapsed = formatDuration(Date.now() - state.startedAt);
  return `[flow] ${state.currentPhase} ● ${completed}/${total} | ${tokens} tokens | ${elapsed}`;
}

// ── Helpers ──────────────────────────────────────────────────────────

function truncate(text: string, maxLen: number) {
  if (text.length <= maxLen) return text;
  return `${text.slice(0, maxLen - 3)}...`;
}
