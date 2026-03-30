/**
 * Shared helpers for workflow integration.
 */

import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import type { TUI } from "@mariozechner/pi-tui";
import type { AgentManager } from "../agents/manager.js";
import type { AgentActivity } from "../ui/formatters.js";
import { buildProgressLines, buildStatusText, formatDuration } from "./progress.js";
import { readState } from "./store.js";
import type { WorkflowDefinition, WorkflowState } from "./types.js";

export const ENTRY_TYPE = "pi-flow:active";
const WIDGET_KEY = "pi-flow";
export const STALLED_TIMEOUT_MS = 5 * 60 * 1000;

let widgetTui: TUI | undefined;
let widgetRegistered = false;
let widgetInterval: ReturnType<typeof setInterval> | undefined;
let cachedLines: string[] = [];

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
}: {
  ctx: ExtensionContext;
  activeDefinition: WorkflowDefinition | undefined;
  activeState: WorkflowState | undefined;
  manager?: AgentManager | undefined;
  agentActivity?: Map<string, AgentActivity> | undefined;
}) {
  if (!activeState || !activeDefinition) {
    if (widgetRegistered) {
      ctx.ui.setWidget(WIDGET_KEY, undefined);
      widgetRegistered = false;
      widgetTui = undefined;
    }
    if (widgetInterval) {
      clearInterval(widgetInterval);
      widgetInterval = undefined;
    }
    cachedLines = [];
    ctx.ui.setStatus(WIDGET_KEY, undefined);
    return;
  }

  // Update cached data from in-memory state (no disk I/O)
  const runningAgents = manager?.listAgents().filter((a) => a.status === "running");
  cachedLines = buildProgressLines({ state: activeState, definition: activeDefinition, runningAgents, agentActivity });
  ctx.ui.setStatus(WIDGET_KEY, buildStatusText(activeState));

  if (!widgetRegistered) {
    ctx.ui.setWidget(
      WIDGET_KEY,
      (tui) => {
        widgetTui = tui;
        return {
          render: () => cachedLines,
          invalidate: () => {
            widgetRegistered = false;
            widgetTui = undefined;
          },
        };
      },
      { placement: "aboveEditor" },
    );
    widgetRegistered = true;
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
