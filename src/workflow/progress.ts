/**
 * Progress rendering — widget lines, status bar text, format helpers.
 * Pure functions — no I/O, no side effects.
 */

import type { AgentRecord } from "../types.js";
import { type AgentActivity, describeActivity } from "../ui/formatters.js";
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

function formatAgentStats(agent: AgentRecord, activity?: AgentActivity | undefined) {
  const elapsed = formatDuration(Date.now() - agent.startedAt);
  const parts: string[] = [];
  const turns = activity?.turnCount ?? agent.turnCount;
  const tools = activity?.toolUses ?? agent.toolUses;
  if (turns > 0) parts.push(`⟳${turns}`);
  if (tools > 0) parts.push(`${tools} tools`);
  try {
    const session = activity?.session ?? agent.session;
    const tokens = session?.getSessionStats().tokens.total;
    if (tokens) parts.push(formatTokens(tokens));
  } catch {
    /* */
  }
  parts.push(elapsed);
  return parts.join(" · ");
}

function formatAgentActivity(activity?: AgentActivity | undefined) {
  if (!activity) return undefined;
  return describeActivity(activity.activeTools, activity.responseText);
}

function appendRunningPhase({
  lines,
  icon,
  phaseName,
  agents,
  activityMap,
}: {
  lines: string[];
  icon: string;
  phaseName: string;
  agents: readonly AgentRecord[];
  activityMap?: Map<string, AgentActivity> | undefined;
}) {
  const first = agents[0];
  const stats = first ? formatAgentStats(first, activityMap?.get(first.id)) : "";
  lines.push(`  ${icon} ${phaseName} · ${stats}`);
  const actText = first ? formatAgentActivity(activityMap?.get(first.id)) : undefined;
  if (actText) lines.push(`    ⎿ ${actText}`);
  for (const a of agents.slice(1)) {
    lines.push(`    ${a.type} · ${formatAgentStats(a, activityMap?.get(a.id))}`);
    const act = formatAgentActivity(activityMap?.get(a.id));
    if (act) lines.push(`      ⎿ ${act}`);
  }
}

export function buildProgressLines({
  state,
  definition,
  runningAgents,
  agentActivity,
}: {
  state: WorkflowState;
  definition: WorkflowDefinition;
  runningAgents?: readonly AgentRecord[] | undefined;
  agentActivity?: Map<string, AgentActivity> | undefined;
}) {
  const lines: string[] = [];

  lines.push(`Flow: ${state.type} — ${truncate(state.description, 60)}`);

  for (const p of definition.phases) {
    const result = state.phases[p.name];
    const status: PhaseStatus = result?.status ?? "pending";
    const icon = getStatusIcon(status);

    if (status === "running" && runningAgents && runningAgents.length > 0) {
      appendRunningPhase({ lines, icon, phaseName: p.name, agents: runningAgents, activityMap: agentActivity });
    } else {
      const duration = result?.completedAt
        ? ` (${formatDuration(result.completedAt - (result.startedAt ?? state.startedAt))})`
        : "";
      lines.push(`  ${icon} ${p.name}${duration}`);
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
