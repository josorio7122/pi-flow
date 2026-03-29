/**
 * Integration — wire workflow tooling into pi's extension API.
 *
 * Registers: Workflow tool, /flow command, session_start hook, turn_end hook.
 * This is the only workflow file that depends on pi's extension API.
 */

import { randomUUID } from "node:crypto";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import type { AgentManager } from "../agents/manager.js";
import { executeCurrentPhase } from "./executor.js";
import { registerFlowCommand } from "./flow-command.js";
import {
  type ActiveWorkflowBookmark,
  buildWorkflowStatusText,
  ENTRY_TYPE,
  findLatestBookmark,
  refreshWidget,
  STALLED_TIMEOUT_MS,
  textResult,
} from "./helpers.js";
import { loadWorkflowDefinitions } from "./loader.js";
import { createWorkflowState, updatePhaseStatus } from "./pipeline.js";
import { findStalled, formatStalledMessage } from "./recovery.js";
import { appendEvent, initWorkflowDir, readState, writeState } from "./store.js";
import type { WorkflowDefinition, WorkflowEvent } from "./types.js";

export function registerWorkflowExtension(
  pi: ExtensionAPI,
  { builtinWorkflowsDir, deps }: { builtinWorkflowsDir?: string; deps?: { manager?: AgentManager } } = {},
) {
  let workflows = new Map<string, WorkflowDefinition>();
  let activeWorkflowId: string | undefined;
  let activeDefinition: WorkflowDefinition | undefined;

  function emitEvent(cwd: string, event: WorkflowEvent) {
    if (activeWorkflowId) appendEvent({ cwd: cwd, workflowId: activeWorkflowId, event: event });
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
    // biome-ignore lint/complexity/useMaxParams: pi tool execute callback signature is fixed
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      if (params.action === "status") return buildWorkflowStatusText({ ctx, activeWorkflowId });
      if (params.action === "continue") return continueWorkflow(ctx);
      return startWorkflow({ typeName: params.workflow_type, desc: params.description ?? "", ctx });
    },
  });

  function startWorkflow({
    typeName,
    desc,
    ctx,
  }: {
    typeName: string | undefined;
    desc: string;
    ctx: ExtensionContext;
  }) {
    if (!typeName) return textResult("Error: workflow_type is required for action 'start'.", true);
    const definition = workflows.get(typeName);
    if (!definition)
      return textResult(`Unknown workflow: "${typeName}". Available: ${Array.from(workflows.keys()).join(", ")}`, true);
    if (activeWorkflowId)
      return textResult(`A workflow is already active (${activeWorkflowId}). Check with action "status".`, true);

    const workflowId = `flow-${randomUUID().slice(0, 8)}`;
    initWorkflowDir(ctx.cwd, workflowId);
    const state = createWorkflowState({ definition, description: desc, workflowId });
    writeState({ cwd: ctx.cwd, workflowId: workflowId, state: state });

    activeWorkflowId = workflowId;
    activeDefinition = definition;
    pi.appendEntry(ENTRY_TYPE, {
      workflowId,
      workflowDir: `.pi/flow/${workflowId}`,
      startedAt: new Date().toISOString(),
    } satisfies ActiveWorkflowBookmark);
    emitEvent(ctx.cwd, { type: "workflow_start", workflowType: definition.name, description: desc, ts: Date.now() });
    doRefreshWidget(ctx);

    if (!deps?.manager) {
      const phaseList = definition.phases.map((p) => `${p.name} (${p.mode})`).join(" → ");
      return textResult(
        `Workflow "${definition.name}" started (${workflowId}).\n\nPhases: ${phaseList}\n\nDescription: ${desc}\n\nThe first phase is "${definition.phases[0]?.name}". Spawn the appropriate agent to begin.`,
      );
    }

    return runPhaseAndReport(ctx);
  }

  async function runPhaseAndReport(ctx: ExtensionContext) {
    if (!activeWorkflowId || !activeDefinition || !deps?.manager) {
      return textResult("No active workflow or manager not available.", true);
    }
    const state = readState({ cwd: ctx.cwd, workflowId: activeWorkflowId });
    if (!state) return textResult("Workflow state not found.", true);

    const outcome = await executeCurrentPhase({
      definition: activeDefinition,
      state,
      cwd: ctx.cwd,
      workflowId: activeWorkflowId,
      pi,
      ctx,
      manager: deps.manager,
    });

    doRefreshWidget(ctx);

    if (outcome.type === "workflow-complete") {
      const result = `Workflow completed: ${outcome.exitReason}.`;
      activeWorkflowId = undefined;
      activeDefinition = undefined;
      doRefreshWidget(ctx);
      return textResult(result);
    }
    if (outcome.type === "gate-waiting") {
      return textResult(
        `Workflow paused at approval gate: "${state.currentPhase}". Review the results above and use Workflow({ action: "continue" }) to proceed.`,
      );
    }
    if (outcome.type === "error") {
      return textResult(`Workflow error: ${outcome.error}`, true);
    }
    if (outcome.type === "stuck") {
      return textResult(`Workflow stuck: ${outcome.reason}. Consider manual intervention.`, true);
    }
    return textResult("Phase completed.");
  }

  async function continueWorkflow(ctx: ExtensionContext) {
    if (!activeWorkflowId || !activeDefinition) {
      return textResult("No active workflow to continue.", true);
    }
    const state = readState({ cwd: ctx.cwd, workflowId: activeWorkflowId });
    if (!state) return textResult("Workflow state not found.", true);

    // Advance past gate
    const currentPhase = activeDefinition.phases.find((p) => p.name === state.currentPhase);
    if (currentPhase?.mode === "gate") {
      updatePhaseStatus({
        state,
        phase: state.currentPhase,
        status: "complete",
        onEvent: (e) => emitEvent(ctx.cwd, e),
      });
      emitEvent(ctx.cwd, { type: "approval", phase: state.currentPhase, decision: "approved", ts: Date.now() });

      const nextIndex = activeDefinition.phases.findIndex((p) => p.name === state.currentPhase) + 1;
      const nextPhase = activeDefinition.phases[nextIndex];
      if (!nextPhase) {
        state.exitReason = "clean";
        state.completedAt = Date.now();
        writeState({ cwd: ctx.cwd, workflowId: activeWorkflowId, state: state });
        activeWorkflowId = undefined;
        activeDefinition = undefined;
        doRefreshWidget(ctx);
        return textResult("Workflow completed (no more phases after gate).");
      }
      state.currentPhase = nextPhase.name;
      writeState({ cwd: ctx.cwd, workflowId: activeWorkflowId, state: state });
    }

    if (!deps?.manager) {
      return textResult(
        `Workflow resumed at phase "${state.currentPhase}". Spawn the ${currentPhase?.role ?? "next"} agent to continue.`,
      );
    }

    return runPhaseAndReport(ctx);
  }

  // ── /flow Command ──────────────────────────────────────────────

  registerFlowCommand({
    pi,
    getActiveWorkflowId: () => activeWorkflowId,
    setActiveWorkflow: (id, def) => {
      activeWorkflowId = id;
      activeDefinition = def;
    },
    emitEvent,
    doRefreshWidget,
  });

  // ── Hooks ──────────────────────────────────────────────────────

  pi.on("session_start", async (_, ctx) => {
    workflows = loadWorkflowDefinitions(ctx.cwd, builtinWorkflowsDir);
    const bookmark = findLatestBookmark(ctx.sessionManager.getEntries());
    if (!bookmark) return;
    const state = readState({ cwd: ctx.cwd, workflowId: bookmark.workflowId });
    if (!state || state.completedAt) return;
    activeWorkflowId = bookmark.workflowId;
    activeDefinition = workflows.get(state.definitionName);
    const stalled = findStalled({ agents: state.activeAgents, timeoutMs: STALLED_TIMEOUT_MS });
    for (const agent of stalled) ctx.ui.notify(`\u26A0 ${formatStalledMessage(agent)}`, "warning");
    if (stalled.length > 0)
      ctx.ui.notify(`Workflow "${state.type}" was interrupted. Say "resume workflow" to continue.`, "warning");
    doRefreshWidget(ctx);
  });

  pi.on("turn_end", async (_, ctx) => {
    if (activeWorkflowId) doRefreshWidget(ctx);
  });

  return { getActiveWorkflowId: () => activeWorkflowId, getWorkflows: () => workflows };
}
