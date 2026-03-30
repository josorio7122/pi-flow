/**
 * Shared helpers for workflow integration.
 */

import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import type { AgentManager } from "../agents/manager.js";
import { buildProgressLines, buildStatusText, formatDuration } from "./progress.js";
import { readState } from "./store.js";
import type { WorkflowDefinition } from "./types.js";

export const ENTRY_TYPE = "pi-flow:active";
const WIDGET_KEY = "pi-flow";
export const STALLED_TIMEOUT_MS = 5 * 60 * 1000;

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
  activeWorkflowId,
  activeDefinition,
  manager,
}: {
  ctx: ExtensionContext;
  activeWorkflowId: string | undefined;
  activeDefinition: WorkflowDefinition | undefined;
  manager?: AgentManager | undefined;
}) {
  if (!activeWorkflowId || !activeDefinition) {
    ctx.ui.setWidget(WIDGET_KEY, undefined);
    ctx.ui.setStatus(WIDGET_KEY, undefined);
    return;
  }
  const state = readState({ cwd: ctx.cwd, workflowId: activeWorkflowId });
  if (!state) {
    ctx.ui.setWidget(WIDGET_KEY, undefined);
    ctx.ui.setStatus(WIDGET_KEY, undefined);
    return;
  }
  const runningAgents = manager?.listAgents().filter((a) => a.status === "running");
  const lines = buildProgressLines({ state, definition: activeDefinition, runningAgents });
  ctx.ui.setWidget(WIDGET_KEY, lines);
  ctx.ui.setStatus(WIDGET_KEY, buildStatusText(state));
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
