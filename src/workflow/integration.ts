/**
 * Integration — wire workflow tooling into pi's extension API.
 *
 * Registers: Workflow tool, /flow command, session_start hook, turn_end hook.
 * This is the only workflow file that depends on pi's extension API.
 */

import { randomUUID } from "node:crypto";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import {
  type ActiveWorkflowBookmark,
  buildWorkflowContinueText,
  buildWorkflowStatusText,
  ENTRY_TYPE,
  findLatestBookmark,
  refreshWidget,
  STALLED_TIMEOUT_MS,
  textResult,
} from "./helpers.js";
import { loadWorkflowDefinitions } from "./loader.js";
import { createWorkflowState } from "./pipeline.js";
import { formatDuration } from "./progress.js";
import { findStalled, formatStalledMessage } from "./recovery.js";
import { appendEvent, initWorkflowDir, listHandoffs, readEvents, readState, writeState } from "./store.js";
import type { WorkflowDefinition, WorkflowEvent } from "./types.js";

export function registerWorkflowExtension(pi: ExtensionAPI, builtinWorkflowsDir?: string) {
  let workflows = new Map<string, WorkflowDefinition>();
  let activeWorkflowId: string | undefined;
  let activeDefinition: WorkflowDefinition | undefined;

  function emitEvent(cwd: string, event: WorkflowEvent) {
    if (activeWorkflowId) appendEvent(cwd, activeWorkflowId, event);
  }

  function doRefreshWidget(ctx: ExtensionContext) {
    refreshWidget({ ctx, activeWorkflowId, activeDefinition });
  }

  // ── Workflow Tool ────────────────────────────────────────────────

  function buildToolDescription() {
    const defs = Array.from(workflows.values());
    if (defs.length === 0) return "No workflows available.";
    const listing = defs
      .map((w) => {
        const triggers = w.triggers.length > 0 ? `\n    Use when: ${w.triggers.join("; ")}` : "";
        return `  - ${w.name}: ${w.description}${triggers}`;
      })
      .join("\n");
    return `Trigger a structured workflow for complex multi-step tasks.\n\nAvailable workflows:\n${listing}\n\nUse action "start" to begin, "continue" to resume, "status" to check.`;
  }

  pi.registerTool({
    name: "Workflow",
    label: "Workflow",
    description: buildToolDescription(),
    parameters: Type.Object({
      action: Type.String({ description: '"start", "continue", or "status"' }),
      workflow_type: Type.Optional(Type.String({ description: "Which workflow (required for start)" })),
      description: Type.Optional(Type.String({ description: "What the user wants done (required for start)" })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      if (params.action === "status") return buildWorkflowStatusText({ ctx, activeWorkflowId });
      if (params.action === "continue")
        return buildWorkflowContinueText({ activeWorkflowId, activeDefinition, cwd: ctx.cwd });
      return startWorkflow(params.workflow_type, params.description ?? "", ctx);
    },
  });

  function startWorkflow(typeName: string | undefined, desc: string, ctx: ExtensionContext) {
    if (!typeName) return textResult("Error: workflow_type is required for action 'start'.", true);
    const definition = workflows.get(typeName);
    if (!definition)
      return textResult(`Unknown workflow: "${typeName}". Available: ${Array.from(workflows.keys()).join(", ")}`, true);
    if (activeWorkflowId)
      return textResult(`A workflow is already active (${activeWorkflowId}). Check with action "status".`, true);

    const workflowId = `flow-${randomUUID().slice(0, 8)}`;
    initWorkflowDir(ctx.cwd, workflowId);
    const state = createWorkflowState({ definition, description: desc, workflowId });
    writeState(ctx.cwd, workflowId, state);

    activeWorkflowId = workflowId;
    activeDefinition = definition;
    pi.appendEntry(ENTRY_TYPE, {
      workflowId,
      workflowDir: `.pi/flow/${workflowId}`,
      startedAt: new Date().toISOString(),
    } satisfies ActiveWorkflowBookmark);
    emitEvent(ctx.cwd, { type: "workflow_start", workflowType: definition.name, description: desc, ts: Date.now() });
    doRefreshWidget(ctx);

    const phaseList = definition.phases.map((p) => `${p.name} (${p.mode})`).join(" → ");
    const instructions = definition.orchestratorInstructions
      ? `Instructions:\n${definition.orchestratorInstructions}\n\n`
      : "";
    return textResult(
      `Workflow "${definition.name}" started (${workflowId}).\n\nPhases: ${phaseList}\n\nDescription: ${desc}\n\n${instructions}The first phase is "${definition.phases[0]?.name}". Spawn the appropriate agent to begin.`,
    );
  }

  // ── /flow Command ──────────────────────────────────────────────

  pi.registerCommand("flow", {
    description: "View workflow progress and manage active workflows",
    handler: async (_args, ctx) => {
      if (!activeWorkflowId) {
        ctx.ui.notify("No active workflow.", "info");
        return;
      }
      const state = readState(ctx.cwd, activeWorkflowId);
      if (!state) {
        ctx.ui.notify("Workflow state not found.", "error");
        return;
      }
      const events = readEvents(ctx.cwd, activeWorkflowId);
      const handoffs = listHandoffs(ctx.cwd, activeWorkflowId);
      const elapsed = formatDuration(Date.now() - state.startedAt);
      const lines = [
        `Workflow: ${state.type} — ${state.description}`,
        `ID: ${state.id} | Phase: ${state.currentPhase} | Elapsed: ${elapsed}`,
        `Tokens: ${state.tokens.total} | Review cycles: ${state.reviewCycle}`,
        "",
        "Phases:",
        ...Object.values(state.phases).map(
          (p) =>
            `  ${p.status === "complete" ? "\u2713" : p.status === "running" ? "\u25CF" : "\u25CB"} ${p.phase} (${p.status})`,
        ),
        "",
        `Handoffs: ${handoffs.length} | Events: ${events.length}`,
      ];
      const choice = await ctx.ui.select(lines.join("\n"), ["Close", "Abort workflow"]);
      if (choice === "Abort workflow") {
        const confirmed = await ctx.ui.confirm("Abort workflow?", `This will stop ${state.id}`);
        if (confirmed) {
          state.exitReason = "user_abort";
          state.completedAt = Date.now();
          writeState(ctx.cwd, activeWorkflowId, state);
          emitEvent(ctx.cwd, {
            type: "workflow_complete",
            exitReason: "user_abort",
            totalDuration: Date.now() - state.startedAt,
            totalTokens: state.tokens.total,
            ts: Date.now(),
          });
          activeWorkflowId = undefined;
          activeDefinition = undefined;
          doRefreshWidget(ctx);
          ctx.ui.notify("Workflow aborted.", "info");
        }
      }
    },
  });

  // ── Hooks ──────────────────────────────────────────────────────

  pi.on("session_start", async (_event, ctx) => {
    workflows = loadWorkflowDefinitions(ctx.cwd, builtinWorkflowsDir);
    const bookmark = findLatestBookmark(ctx.sessionManager.getEntries());
    if (!bookmark) return;
    const state = readState(ctx.cwd, bookmark.workflowId);
    if (!state || state.completedAt) return;
    activeWorkflowId = bookmark.workflowId;
    activeDefinition = workflows.get(state.definitionName);
    const stalled = findStalled({ agents: state.activeAgents, timeoutMs: STALLED_TIMEOUT_MS });
    for (const agent of stalled) ctx.ui.notify(`\u26A0 ${formatStalledMessage(agent)}`, "warning");
    if (stalled.length > 0)
      ctx.ui.notify(`Workflow "${state.type}" was interrupted. Say "resume workflow" to continue.`, "warning");
    doRefreshWidget(ctx);
  });

  pi.on("turn_end", async (_event, ctx) => {
    if (activeWorkflowId) doRefreshWidget(ctx);
  });

  return { getActiveWorkflowId: () => activeWorkflowId, getWorkflows: () => workflows };
}
