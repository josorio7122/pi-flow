/**
 * Shared helpers for workflow integration.
 */

import type { ExtensionContext, Theme } from "@mariozechner/pi-coding-agent";
import { type TUI, truncateToWidth } from "@mariozechner/pi-tui";
import type { AgentManager } from "../agents/manager.js";
import type { Registry } from "../agents/registry.js";
import type { AgentActivity } from "../ui/formatters.js";
import { SPINNER } from "../ui/formatters.js";
import { renderRunningLine } from "../ui/widget-render.js";
import { buildStatusText, formatDuration, getStatusIcon } from "./progress.js";
import { readState } from "./store.js";
import type { WorkflowDefinition, WorkflowState } from "./types.js";

export const ENTRY_TYPE = "pi-flow:active";
const WIDGET_KEY = "pi-flow";
export const STALLED_TIMEOUT_MS = 5 * 60 * 1000;

let widgetTui: TUI | undefined;
let widgetRegistered = false;
let widgetTimer: ReturnType<typeof setInterval> | undefined;

// Render deps — kept in module scope so render() reads live data without disk I/O
let renderState: WorkflowState | undefined;
let renderDefinition: WorkflowDefinition | undefined;
let renderManager: AgentManager | undefined;
let renderActivity: Map<string, AgentActivity> | undefined;
let renderRegistry: Registry | undefined;
let renderTheme: Theme | undefined;
let widgetFrame = 0;

function wordWrap(text: string, width: number) {
  const result: string[] = [];
  for (const line of text.split("\n")) {
    if (line.length <= width) {
      result.push(line);
    } else {
      let remaining = line;
      while (remaining.length > width) {
        const breakAt = remaining.lastIndexOf(" ", width);
        const splitAt = breakAt > 0 ? breakAt : width;
        result.push(remaining.slice(0, splitAt));
        remaining = remaining.slice(splitAt).trimStart();
      }
      if (remaining) result.push(remaining);
    }
  }
  return result;
}

const MAX_ACTIVITY_LINES = 15;

function renderAgentInWorkflow({
  lines,
  agent,
  theme,
  frame,
}: {
  lines: string[];
  agent: import("../types.js").AgentRecord;
  theme: Theme;
  frame: string;
}) {
  const activity = renderActivity?.get(agent.id);
  const config = renderRegistry?.getConfig(agent.type) ?? { displayName: agent.type };
  const pair = renderRunningLine({ agent, theme, activity, config, frame });
  lines.push(pair.header);

  if (!activity?.responseText) {
    lines.push(pair.activity);
    return;
  }

  // Build formatted log from responseText
  const rawLines = activity.responseText.split("\n").filter((l) => l.length > 0);
  const formatted: string[] = [];
  for (const raw of rawLines) {
    if (raw.startsWith("→ ")) {
      // Tool call header — highlighted
      formatted.push(`${theme.fg("dim", "│")}  ${theme.fg("accent", raw)}`);
    } else {
      // Tool result or LLM text — dim, wrapped
      const wrapped = wordWrap(raw, 85);
      for (const w of wrapped) {
        formatted.push(`${theme.fg("dim", "│")}    ${theme.fg("dim", w)}`);
      }
    }
  }

  // Show last N lines (scroll to bottom)
  const visible = formatted.slice(-MAX_ACTIVITY_LINES);
  for (const l of visible) lines.push(l);
}

function renderCompletedPhase({ p, status, theme }: { p: { name: string }; status: string; theme: Theme }) {
  if (!renderState) return "";
  const result = renderState.phases[p.name];
  const icon = getStatusIcon(status);
  const duration = result?.completedAt
    ? ` ${theme.fg("dim", `(${formatDuration(result.completedAt - (result.startedAt ?? renderState.startedAt))})`)}`
    : "";
  const color = status === "complete" ? "success" : status === "failed" ? "error" : "dim";
  return `${theme.fg("dim", "├─")} ${theme.fg(color, icon)} ${theme.fg("dim", p.name)}${duration}`;
}

function renderWorkflowWidget(tui: TUI) {
  if (!renderState || !renderDefinition || !renderTheme) return [];
  const theme = renderTheme;
  const running = renderManager?.listAgents().filter((a) => a.status === "running") ?? [];
  const frame = SPINNER[widgetFrame++ % SPINNER.length] ?? "⠋";
  const desc =
    renderState.description.length > 60 ? `${renderState.description.slice(0, 57)}...` : renderState.description;

  const lines: string[] = [
    `${theme.fg("accent", "●")} ${theme.fg("accent", `Flow: ${renderState.type}`)} ${theme.fg("dim", "—")} ${theme.fg("dim", desc)}`,
  ];

  for (const p of renderDefinition.phases) {
    const status = renderState.phases[p.name]?.status ?? "pending";
    if (status === "running" && running.length > 0) {
      for (const agent of running) renderAgentInWorkflow({ lines, agent, theme, frame });
    } else {
      lines.push(renderCompletedPhase({ p, status, theme }));
    }
  }

  if (lines.length > 1) {
    const last = lines.length - 1;
    lines[last] = lines[last]!.replace("├─", "└─").replace("│  ", "   ");
  }
  return lines.map((l) => truncateToWidth(l, tui.terminal.columns));
}

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
    ctx.ui.setStatus(WIDGET_KEY, undefined);
    return;
  }

  // Update render deps (all in-memory, no disk I/O)
  renderState = activeState;
  renderDefinition = activeDefinition;
  renderManager = manager;
  renderActivity = agentActivity;
  renderRegistry = registry;
  // Compute live tokens from running agents
  let liveTokens = activeState.tokens.total;
  if (manager) {
    for (const a of manager.listAgents()) {
      if (a.status === "running" && a.session) {
        try {
          liveTokens += a.session.getSessionStats().tokens.total;
        } catch {
          /* */
        }
      }
    }
  }
  ctx.ui.setStatus(WIDGET_KEY, buildStatusText(activeState, liveTokens));

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
