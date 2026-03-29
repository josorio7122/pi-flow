/**
 * Shared helpers for workflow integration.
 */

import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import { buildProgressLines, buildStatusText, formatDuration } from "./progress.js";
import { readState } from "./store.js";
import type { WorkflowDefinition } from "./types.js";

export const ENTRY_TYPE = "pi-flow:active";
export const WIDGET_KEY = "pi-flow";
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
}: {
  ctx: ExtensionContext;
  activeWorkflowId: string | undefined;
  activeDefinition: WorkflowDefinition | undefined;
}) {
  if (!activeWorkflowId || !activeDefinition) {
    ctx.ui.setWidget(WIDGET_KEY, undefined);
    ctx.ui.setStatus(WIDGET_KEY, undefined);
    return;
  }
  const state = readState(ctx.cwd, activeWorkflowId);
  if (!state) {
    ctx.ui.setWidget(WIDGET_KEY, undefined);
    ctx.ui.setStatus(WIDGET_KEY, undefined);
    return;
  }
  const lines = buildProgressLines({ state, definition: activeDefinition });
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
  const state = readState(ctx.cwd, activeWorkflowId);
  if (!state) return textResult("Workflow state not found.", true);

  const phases = Object.values(state.phases)
    .map((p) => `${p.phase}: ${p.status}`)
    .join(", ");
  const elapsed = formatDuration(Date.now() - state.startedAt);
  return textResult(
    `Workflow: ${state.type} (${state.id})\nPhase: ${state.currentPhase}\nPhases: ${phases}\nTokens: ${state.tokens.total} | Elapsed: ${elapsed}`,
  );
}

export function buildWorkflowContinueText({
  activeWorkflowId,
  activeDefinition,
  cwd,
}: {
  activeWorkflowId: string | undefined;
  activeDefinition: WorkflowDefinition | undefined;
  cwd: string;
}) {
  if (!activeWorkflowId || !activeDefinition) {
    return textResult("No active workflow to continue.", true);
  }
  const state = readState(cwd, activeWorkflowId);
  if (!state) return textResult("Workflow state not found.", true);

  const currentPhase = activeDefinition.phases.find((p) => p.name === state.currentPhase);
  if (!currentPhase) return textResult("Current phase not found in definition.", true);

  return textResult(
    `Workflow "${state.type}" resumed at phase "${state.currentPhase}" (${currentPhase.mode}).\n` +
      `Continue with the ${currentPhase.role ?? "next"} agent.`,
  );
}

export function findLatestBookmark(entries: readonly { type: string; customType?: string; data?: unknown }[]) {
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (entry?.type === "custom" && entry.customType === ENTRY_TYPE && entry.data) {
      return entry.data as ActiveWorkflowBookmark;
    }
  }
  return null;
}
