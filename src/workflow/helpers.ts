/**
 * Shared helpers for workflow integration.
 */

import type { ExtensionContext, Theme } from "@mariozechner/pi-coding-agent";
import { type TUI, truncateToWidth } from "@mariozechner/pi-tui";
import type { AgentManager } from "../agents/manager.js";
import type { Registry } from "../agents/registry.js";
import type { AgentRecord } from "../types.js";
import { type AgentActivity, formatMs, formatTokens, formatTurns, getDisplayName, SPINNER } from "../ui/formatters.js";
import { buildStatusText, formatDuration, getStatusIcon } from "./progress.js";
import { readState } from "./store.js";
import type { WorkflowDefinition, WorkflowState } from "./types.js";

export const ENTRY_TYPE = "pi-flow:active";
const WIDGET_KEY = "pi-flow";
export const STALLED_TIMEOUT_MS = 5 * 60 * 1000;

let widgetTui: TUI | undefined;
let widgetRegistered = false;
let widgetTimer: ReturnType<typeof setInterval> | undefined;

// Render deps — module scope so render() reads live data without disk I/O
let renderState: WorkflowState | undefined;
let renderDefinition: WorkflowDefinition | undefined;
let renderManager: AgentManager | undefined;
let renderActivity: Map<string, AgentActivity> | undefined;
let renderRegistry: Registry | undefined;
let renderTheme: Theme | undefined;
let widgetFrame = 0;

// ── Agent Rendering ──────────────────────────────────────────────────

const ACTIVITY_LINES = 4;

function renderRunningAgent({
  lines,
  agent,
  theme,
  frame,
}: {
  lines: string[];
  agent: AgentRecord;
  theme: Theme;
  frame: string;
}) {
  const activity = renderActivity?.get(agent.id);
  const config = renderRegistry?.getConfig(agent.type) ?? { displayName: agent.type };
  const name = getDisplayName(agent.type, config.displayName);
  const truncDesc = agent.description.length > 50 ? `${agent.description.slice(0, 47)}...` : agent.description;
  const elapsed = formatMs(Date.now() - agent.startedAt);

  const toolUses = activity?.toolUses ?? agent.toolUses;
  let tokenText = "";
  if (activity?.session) {
    try {
      tokenText = formatTokens(activity.session.getSessionStats().tokens.total);
    } catch {
      /* */
    }
  }

  const parts: string[] = [];
  if (activity) parts.push(formatTurns(activity.turnCount, activity.maxTurns));
  if (toolUses > 0) parts.push(`${toolUses} tools`);
  if (tokenText) parts.push(tokenText);
  parts.push(elapsed);

  lines.push(
    `${theme.fg("dim", "├─")} ${theme.fg("accent", frame)} ${theme.bold(name)}  ${theme.fg("muted", truncDesc)} ${theme.fg("dim", "·")} ${theme.fg("dim", parts.join(" · "))}`,
  );

  // Structured tool log — show last N lines with proper nesting
  if (activity?.toolLog.length) {
    const structured: string[] = [];
    for (const entry of activity.toolLog) {
      structured.push(`${theme.fg("dim", "│")}    ${theme.fg("accent", `→ ${entry.tool}`)}`);
      for (const r of entry.results) {
        const t = r.length > 80 ? `${r.slice(0, 77)}...` : r;
        structured.push(`${theme.fg("dim", "│")}      ${theme.fg("dim", t)}`);
      }
    }
    for (const l of structured.slice(-ACTIVITY_LINES)) lines.push(l);
  } else {
    const actText = activity?.activeTools.size ? "working..." : "thinking…";
    lines.push(`${theme.fg("dim", "│")}    ${theme.fg("dim", actText)}`);
  }
}

function renderCompletedAgent({ lines, agent, theme }: { lines: string[]; agent: AgentRecord; theme: Theme }) {
  const config = renderRegistry?.getConfig(agent.type) ?? { displayName: agent.type };
  const name = getDisplayName(agent.type, config.displayName);
  const truncDesc = agent.description.length > 50 ? `${agent.description.slice(0, 47)}...` : agent.description;
  const dur = formatMs((agent.completedAt ?? Date.now()) - agent.startedAt);
  const tools = agent.toolUses > 0 ? `${agent.toolUses} tools · ` : "";
  lines.push(
    `${theme.fg("dim", "├─")} ${theme.fg("success", "✓")} ${theme.fg("dim", `${name}  ${truncDesc} · ${tools}${dur}`)}`,
  );
}

function renderCompletedPhase({ name, status, theme }: { name: string; status: string; theme: Theme }) {
  if (!renderState) return "";
  const result = renderState.phases[name];
  const icon = getStatusIcon(status);
  const duration = result?.completedAt
    ? ` ${theme.fg("dim", `(${formatDuration(result.completedAt - (result.startedAt ?? renderState.startedAt))})`)}`
    : "";
  const color = status === "complete" ? "success" : status === "failed" ? "error" : "dim";
  return `${theme.fg("dim", "├─")} ${theme.fg(color, icon)} ${theme.fg("dim", name)}${duration}`;
}

// ── Widget Render ────────────────────────────────────────────────────

function renderWorkflowWidget(tui: TUI) {
  if (!renderState || !renderDefinition || !renderTheme) return [];
  const theme = renderTheme;
  const allAgents = renderManager?.listAgents() ?? [];
  const running = allAgents.filter((a) => a.status === "running");
  const completed = allAgents.filter((a) => a.status !== "running" && a.status !== "queued" && a.completedAt);
  const frame = SPINNER[widgetFrame++ % SPINNER.length] ?? "⠋";
  const desc =
    renderState.description.length > 60 ? `${renderState.description.slice(0, 57)}...` : renderState.description;

  const lines: string[] = [
    `${theme.fg("accent", "●")} ${theme.fg("accent", `Flow: ${renderState.type}`)} ${theme.fg("dim", "—")} ${theme.fg("dim", desc)}`,
  ];

  for (const p of renderDefinition.phases) {
    const status = renderState.phases[p.name]?.status ?? "pending";
    if (status === "running") {
      // Phase header
      lines.push(`  ${theme.fg("accent", "●")} ${theme.fg("accent", p.name)}`);
      // Completed agents in this phase
      for (const agent of completed) renderCompletedAgent({ lines, agent, theme });
      // Running agents with live activity
      for (const agent of running) renderRunningAgent({ lines, agent, theme, frame });
    } else {
      lines.push(renderCompletedPhase({ name: p.name, status, theme }));
    }
  }

  // Fix last connector
  if (lines.length > 1) {
    const last = lines.length - 1;
    lines[last] = lines[last]!.replace("├─", "└─").replace("│  ", "   ");
  }
  return lines.map((l) => truncateToWidth(l, tui.terminal.columns));
}

// ── Widget Management ────────────────────────────────────────────────

export interface ActiveWorkflowBookmark {
  workflowId: string;
  workflowDir: string;
  startedAt: string;
}

export function textResult(text: string, isError = false) {
  return {
    content: [{ type: "text" as const, text }],
    details: {},
    ...(isError ? { isError: true } : {}),
  };
}

export function refreshWidget({
  ctx,
  activeDefinition,
  activeState,
  manager,
  agentActivity,
  registry,
}: {
  ctx: ExtensionContext;
  activeDefinition: WorkflowDefinition | undefined;
  activeState: WorkflowState | undefined;
  manager?: AgentManager | undefined;
  agentActivity?: Map<string, AgentActivity> | undefined;
  registry?: Registry | undefined;
}) {
  if (!activeState || !activeDefinition) {
    if (widgetRegistered) {
      ctx.ui.setWidget(WIDGET_KEY, undefined);
      widgetRegistered = false;
      widgetTui = undefined;
    }
    if (widgetTimer) {
      clearInterval(widgetTimer);
      widgetTimer = undefined;
    }
    renderState = undefined;
    renderDefinition = undefined;
    renderManager = undefined;
    renderActivity = undefined;
    renderRegistry = undefined;
    ctx.ui.setStatus(WIDGET_KEY, undefined);
    return;
  }

  // Update render deps
  renderState = activeState;
  renderDefinition = activeDefinition;
  renderManager = manager;
  renderActivity = agentActivity;
  renderRegistry = registry;

  // Compute live stats for status bar
  let liveTokens = activeState.tokens.total;
  const allAgents = manager?.listAgents() ?? [];
  let runningCount = 0;
  let totalCount = 0;
  for (const a of allAgents) {
    totalCount++;
    if (a.status === "running") runningCount++;
    if (a.session) {
      try {
        liveTokens += a.session.getSessionStats().tokens.total;
      } catch {
        /* */
      }
    }
  }
  ctx.ui.setStatus(
    WIDGET_KEY,
    buildStatusText({
      state: activeState,
      liveTokens,
      agentCount: totalCount,
      doneCount: totalCount - runningCount,
    }),
  );

  if (!widgetRegistered) {
    ctx.ui.setWidget(
      WIDGET_KEY,
      (tui, theme) => {
        widgetTui = tui;
        renderTheme = theme;
        return {
          render: () => renderWorkflowWidget(tui),
          invalidate: () => {
            widgetRegistered = false;
            widgetTui = undefined;
            renderTheme = undefined;
          },
        };
      },
      { placement: "aboveEditor" },
    );
    widgetRegistered = true;
    if (!widgetTimer) {
      widgetTimer = setInterval(() => widgetTui?.requestRender(), 80);
    }
  } else {
    widgetTui?.requestRender();
  }
}

// ── Status/Bookmark Helpers ──────────────────────────────────────────

export function buildWorkflowStatusText({
  ctx,
  activeWorkflowId,
}: {
  ctx: ExtensionContext;
  activeWorkflowId: string | undefined;
}) {
  if (!activeWorkflowId) {
    return textResult("No active workflow.");
  }
  const state = readState({ cwd: ctx.cwd, workflowId: activeWorkflowId });
  if (!state) return textResult("Workflow state not found.", true);

  const phases = Object.values(state.phases)
    .map((p) => `${p.phase}: ${p.status}`)
    .join(", ");
  const elapsed = formatDuration(Date.now() - state.startedAt);
  return textResult(
    `Workflow: ${state.type} (${state.id})\nPhase: ${state.currentPhase}\nPhases: ${phases}\nTokens: ${state.tokens.total} | Elapsed: ${elapsed}`,
  );
}

function isBookmark(data: unknown): data is ActiveWorkflowBookmark {
  return (
    typeof data === "object" &&
    data !== null &&
    "workflowId" in data &&
    typeof (data as Record<string, unknown>).workflowId === "string"
  );
}

export function findLatestBookmark(entries: readonly { type: string; customType?: string; data?: unknown }[]) {
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (entry?.type === "custom" && entry.customType === ENTRY_TYPE && isBookmark(entry.data)) {
      return entry.data;
    }
  }
  return null;
}
