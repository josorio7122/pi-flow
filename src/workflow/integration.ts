/**
 * Integration — wire workflow tooling into pi's extension API.
 *
 * Registers: Workflow tool, /flow command, session_start hook, turn_end hook.
 * This is the only workflow file that depends on pi's extension API.
 */

import { randomUUID } from "node:crypto";
import type { AgentToolUpdateCallback } from "@mariozechner/pi-agent-core";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";
import type { AgentManager } from "../agents/manager.js";
import type { Registry } from "../agents/registry.js";
import type { AgentActivity } from "../ui/formatters.js";
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
import { buildStatusText } from "./progress.js";
import { findStalled, formatStalledMessage } from "./recovery.js";
import { appendEvent, initWorkflowDir, listHandoffs, readState, writeState } from "./store.js";
import type { AgentHandoff, WorkflowDefinition, WorkflowEvent, WorkflowState } from "./types.js";

const PROGRESS_INTERVAL_MS = 3000;

function startProgressTimer({
  getState,
  getManager,
  onUpdate,
}: {
  getState: () => WorkflowState | undefined;
  getManager: () => AgentManager | undefined;
  onUpdate: AgentToolUpdateCallback;
}) {
  const timer = setInterval(() => {
    const state = getState();
    if (!state) return;
    let liveTokens = state.tokens.total;
    const mgr = getManager();
    if (mgr) {
      for (const a of mgr.listAgents()) {
        if (a.status === "running" && a.session) {
          try {
            liveTokens += a.session.getSessionStats().tokens.total;
          } catch {
            /* */
          }
        }
      }
    }
    onUpdate({ content: [{ type: "text", text: buildStatusText(state, liveTokens) }], details: {} });
  }, PROGRESS_INTERVAL_MS);
  return () => clearInterval(timer);
}

export function registerWorkflowExtension(
  pi: ExtensionAPI,
  {
    builtinWorkflowsDir,
    deps,
  }: {
    builtinWorkflowsDir?: string;
    deps?: { manager?: AgentManager; agentActivity?: Map<string, AgentActivity>; registry?: Registry };
  } = {},
) {
  let workflows = new Map<string, WorkflowDefinition>();
  let activeWorkflowId: string | undefined;
  let activeDefinition: WorkflowDefinition | undefined;
  let activeState: WorkflowState | undefined;

  function emitEvent(cwd: string, event: WorkflowEvent) {
    if (activeWorkflowId) appendEvent({ cwd, workflowId: activeWorkflowId, event });
  }

  function doRefreshWidget(ctx: ExtensionContext) {
    refreshWidget({
      ctx,
      activeDefinition,
      activeState,
      manager: deps?.manager,
      agentActivity: deps?.agentActivity,
      registry: deps?.registry,
    });
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
    promptSnippet: "Workflow — Orchestrate multi-phase agent pipelines with approval gates and code review",
    promptGuidelines: [
      'User asks to find/scout/explore something AND then fix/clean/refactor/remove it → always Workflow "fix". Build/implement a feature → "feature". Explore then plan/recommend/design → "explore". Just research/map/trace with no follow-up action → "research".',
      "Never scout via Agent then do the fix yourself. Workflow provides approval gates and code review that manual execution skips.",
      "When a workflow phase returns asking for a plan, assess the task complexity and respond with Workflow plan_phase. Use 1 task for focused work, 2-4 tasks for complex multi-area exploration.",
    ],
    description: buildToolDescription(),
    // biome-ignore lint/complexity/useMaxParams: pi renderResult callback signature is fixed
    renderResult: (result, { isPartial }, theme) => {
      const text = result.content[0]?.type === "text" ? result.content[0].text : "";
      if (!text) return new Text("", 0, 0);
      // Partial = streaming progress update — show as-is
      if (isPartial) return new Text(theme.fg("dim", text), 0, 0);
      // Final = compact summary
      const lines = text.split("\n");
      const header = lines[0] ?? "";
      const lineCount = lines.length - 1;
      const icon = header.includes("error") ? theme.fg("error", "✗") : theme.fg("success", "✓");
      let rendered = `${icon} ${theme.fg("dim", header)}`;
      if (lineCount > 1) rendered += `\n  ${theme.fg("dim", `${lineCount} lines of findings delivered to agent`)}`;
      return new Text(rendered, 0, 0);
    },
    parameters: Type.Object({
      action: Type.String({ description: '"start", "continue", "status", or "plan_phase"' }),
      workflow_type: Type.Optional(Type.String({ description: "Which workflow (required for start)" })),
      description: Type.Optional(Type.String({ description: "What the user wants done (required for start)" })),
      tasks: Type.Optional(
        Type.Array(Type.String(), { description: "Task descriptions for auto-mode phase (used with plan_phase)" }),
      ),
    }),
    // biome-ignore lint/complexity/useMaxParams: pi tool execute callback signature is fixed
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      if (params.action === "status") return buildWorkflowStatusText({ ctx, activeWorkflowId });
      if (params.action === "continue") return continueWorkflow({ ctx, signal, onUpdate });
      if (params.action === "plan_phase") return planPhase({ tasks: params.tasks, ctx, signal, onUpdate });
      return startWorkflow({
        typeName: params.workflow_type,
        desc: params.description ?? "",
        ctx,
        signal,
        onUpdate,
      });
    },
  });

  function buildCompletionSummary({ exitReason, handoffs }: { exitReason: string; handoffs: readonly AgentHandoff[] }) {
    const sections: string[] = [`Workflow completed: ${exitReason}.`];
    for (const h of handoffs) {
      sections.push(`\n## ${h.role} (${h.phase} phase)\n${h.findings}`);
    }
    return sections.join("\n");
  }

  function startWorkflow({
    typeName,
    desc,
    ctx,
    signal,
    onUpdate,
  }: {
    typeName: string | undefined;
    desc: string;
    ctx: ExtensionContext;
    signal?: AbortSignal | undefined;
    onUpdate?: AgentToolUpdateCallback | undefined;
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
    writeState({ cwd: ctx.cwd, workflowId, state });

    activeWorkflowId = workflowId;
    activeDefinition = definition;
    activeState = state;
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

    return runPhaseAndReport({ ctx, signal, onUpdate });
  }

  async function runPhaseAndReport({
    ctx,
    signal,
    onUpdate,
  }: {
    ctx: ExtensionContext;
    signal?: AbortSignal | undefined;
    onUpdate?: AgentToolUpdateCallback | undefined;
  }) {
    if (!activeWorkflowId || !activeDefinition || !deps?.manager) {
      return textResult("No active workflow or manager not available.", true);
    }
    if (!activeState) {
      activeState = readState({ cwd: ctx.cwd, workflowId: activeWorkflowId }) ?? undefined;
    }
    if (!activeState) return textResult("Workflow state not found.", true);

    const stopProgress = onUpdate
      ? startProgressTimer({ getState: () => activeState, getManager: () => deps?.manager, onUpdate })
      : undefined;

    doRefreshWidget(ctx);

    let outcome: Awaited<ReturnType<typeof executeCurrentPhase>>;
    try {
      outcome = await executeCurrentPhase({
        definition: activeDefinition,
        state: activeState,
        cwd: ctx.cwd,
        workflowId: activeWorkflowId,
        pi,
        ctx,
        manager: deps.manager,
        signal,
        agentActivity: deps.agentActivity,
      });
    } finally {
      stopProgress?.();
    }

    doRefreshWidget(ctx);

    if (outcome.type === "workflow-complete") {
      const handoffs = listHandoffs({ cwd: ctx.cwd, workflowId: activeWorkflowId });
      const summary = buildCompletionSummary({ exitReason: outcome.exitReason, handoffs });
      activeWorkflowId = undefined;
      activeDefinition = undefined;
      activeState = undefined;
      doRefreshWidget(ctx);
      return textResult(summary);
    }
    if (outcome.type === "gate-waiting") {
      const handoffs = listHandoffs({ cwd: ctx.cwd, workflowId: activeWorkflowId });
      const findings = handoffs.map((h) => `## ${h.role} (${h.phase} phase)\n${h.findings}`).join("\n\n");
      return textResult(
        `Workflow paused at approval gate: "${activeState.currentPhase}".\n\n${findings}\n\nReview the findings above and use Workflow({ action: "continue" }) to proceed, or ask for changes.`,
      );
    }
    if (outcome.type === "needs-planning") {
      return textResult(
        `Phase "${outcome.phase}" is ready. Decide the execution strategy based on task complexity:\n\n` +
          `- Simple/focused task → 1 task\n` +
          `- Complex/multi-area task → 2-4 parallel tasks with distinct focus areas\n\n` +
          `Call: Workflow({ action: "plan_phase", tasks: ["task description", ...] })\n\n` +
          `Task: ${activeState.description}\nRole: ${outcome.role}\nPhase: ${outcome.phase}`,
      );
    }
    if (outcome.type === "error") {
      const handoffs = listHandoffs({ cwd: ctx.cwd, workflowId: activeWorkflowId });
      const findings =
        handoffs.length > 0
          ? `\n\n${handoffs.map((h) => `## ${h.role} (${h.phase} phase)\n${h.findings}`).join("\n\n")}`
          : "";
      return textResult(`Workflow error: ${outcome.error}${findings}`, true);
    }
    if (outcome.type === "stuck") {
      return textResult(`Workflow stuck: ${outcome.reason}. Consider manual intervention.`, true);
    }
    return textResult("Phase completed.");
  }

  function planPhase({
    tasks,
    ctx,
    signal,
    onUpdate,
  }: {
    tasks: readonly string[] | undefined;
    ctx: ExtensionContext;
    signal?: AbortSignal | undefined;
    onUpdate?: AgentToolUpdateCallback | undefined;
  }) {
    if (!activeWorkflowId || !activeDefinition || !activeState) {
      return textResult("No active workflow.", true);
    }
    if (!tasks || tasks.length === 0) {
      return textResult("Error: tasks array is required for plan_phase.", true);
    }
    // Store planned tasks on state
    if (!activeState.plannedTasks) activeState.plannedTasks = {};
    activeState.plannedTasks[activeState.currentPhase] = tasks;
    writeState({ cwd: ctx.cwd, workflowId: activeWorkflowId, state: activeState });
    // Resume execution — the auto phase will now find its tasks
    return runPhaseAndReport({ ctx, signal, onUpdate });
  }

  async function continueWorkflow({
    ctx,
    signal,
    onUpdate,
  }: {
    ctx: ExtensionContext;
    signal?: AbortSignal | undefined;
    onUpdate?: AgentToolUpdateCallback | undefined;
  }) {
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
        writeState({ cwd: ctx.cwd, workflowId: activeWorkflowId, state });
        activeWorkflowId = undefined;
        activeDefinition = undefined;
        activeState = undefined;
        doRefreshWidget(ctx);
        return textResult("Workflow completed (no more phases after gate).");
      }
      state.currentPhase = nextPhase.name;
      writeState({ cwd: ctx.cwd, workflowId: activeWorkflowId, state });
    }

    if (!deps?.manager) {
      return textResult(
        `Workflow resumed at phase "${state.currentPhase}". Spawn the ${currentPhase?.role ?? "next"} agent to continue.`,
      );
    }

    return runPhaseAndReport({ ctx, signal, onUpdate });
  }

  // ── /flow Command ──────────────────────────────────────────────

  registerFlowCommand({
    pi,
    getActiveWorkflowId: () => activeWorkflowId,
    getWorkflows: () => workflows,
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
    activeState = state;
    const stalled = findStalled({ agents: state.activeAgents, timeoutMs: STALLED_TIMEOUT_MS });
    for (const agent of stalled) ctx.ui.notify(`\u26A0 ${formatStalledMessage(agent)}`, "warning");
    if (stalled.length > 0)
      ctx.ui.notify(`Workflow "${state.type}" was interrupted. Say "resume workflow" to continue.`, "warning");
    doRefreshWidget(ctx);
  });

  pi.on("before_agent_start", async (event) => {
    const defs = Array.from(workflows.values());
    if (defs.length === 0) return;
    const listing = defs.map((w) => `${w.name}: ${w.description}`).join("; ");
    return {
      systemPrompt:
        `${event.systemPrompt}\n\n## Workflow-First Rule\n` +
        `Always use the Workflow tool for any task. Available workflows: ${listing}. ` +
        `Do not use read, bash, edit, or write directly for tasks that match a workflow. ` +
        `Call Workflow({ action: "start", workflow_type: "<type>", description: "<task>" }) instead.`,
    };
  });

  pi.on("turn_end", async (_, ctx) => {
    if (activeWorkflowId) doRefreshWidget(ctx);
  });

  return { getActiveWorkflowId: () => activeWorkflowId, getWorkflows: () => workflows };
}
