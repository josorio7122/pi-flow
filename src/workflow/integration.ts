/**
 * Integration — wire workflow tooling into pi's extension API.
 *
 * The orchestrator (LLM) drives the workflow step by step:
 *   start   → get first phase info
 *   execute → run current phase with tasks
 *   continue → advance past a gate
 *   status  → check progress
 */

import { randomUUID } from "node:crypto";
import type { AgentToolUpdateCallback } from "@mariozechner/pi-agent-core";
import { StringEnum } from "@mariozechner/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";
import type { AgentManager } from "../agents/manager.js";
import type { Registry } from "../agents/registry.js";
import type { AgentActivity } from "../ui/formatters.js";
import { executeSinglePhase } from "./executor.js";
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

  // ── Phase Info ───────────────────────────────────────────────────

  function buildPhaseInfo() {
    if (!activeDefinition || !activeState) return "";
    const phase = activeDefinition.phases.find((p) => p.name === activeState!.currentPhase);
    if (!phase) return "";
    return (
      `\nCurrent phase: ${phase.name}\nRole: ${phase.role ?? "general-purpose"}\nMode: ${phase.mode}` +
      `\nDescription: ${phase.description}` +
      `\n\nProvide tasks using Workflow({ action: "execute", tasks: ["..."] })` +
      `\n- 1 task for focused work\n- 2-4 tasks for parallel exploration of distinct areas`
    );
  }

  function buildPhaseSummary() {
    if (!activeDefinition || !activeState) return "";
    return activeDefinition.phases
      .map((p) => {
        const status = activeState!.phases[p.name]?.status ?? "pending";
        const icon = status === "complete" ? "✓" : status === "running" ? "●" : "○";
        return `  ${icon} ${p.name} (${p.mode})`;
      })
      .join("\n");
  }

  // ── Tool Description ─────────────────────────────────────────────

  function buildToolDescription() {
    const defs = Array.from(workflows.values());
    if (defs.length === 0) return "No workflows available.";
    const listing = defs
      .map((w) => {
        const triggers = w.triggers.length > 0 ? `\n    Use when: ${w.triggers.join("; ")}` : "";
        return `  - ${w.name}: ${w.description}${triggers}`;
      })
      .join("\n");
    return (
      `Drive a structured workflow through phases step by step.\n\nAvailable workflows:\n${listing}\n\n` +
      `Actions:\n` +
      `  start   — Begin a workflow. Returns the first phase to execute.\n` +
      `  execute — Run current phase. Provide tasks (1 = single agent, multiple = parallel).\n` +
      `  continue — Advance past an approval gate.\n` +
      `  status  — Check workflow progress.\n\n` +
      `Example:\n` +
      `  Workflow({ action: "start", workflow_type: "explore", description: "Map the payment system" })\n` +
      `  → Phase "scout" ready. Provide tasks.\n` +
      `  Workflow({ action: "execute", tasks: ["Map data model", "Map API", "Map frontend"] })\n` +
      `  → Findings + next phase info.\n` +
      `  Workflow({ action: "execute", tasks: ["Synthesize into recommendations"] })\n` +
      `  → Done.`
    );
  }

  // ── Tool Registration ────────────────────────────────────────────

  pi.registerTool({
    name: "Workflow",
    label: "Workflow",
    promptSnippet: "Workflow — Start and drive multi-phase agent pipelines step by step",
    promptGuidelines: [
      'User asks to find/scout something AND fix/clean/refactor it → Workflow "fix". Build a feature → "feature". Explore then plan/recommend → "explore". Research/map/trace → "research".',
      "After starting a workflow, drive it by calling execute for each phase. You decide what tasks to give each phase and whether to use 1 or multiple parallel agents.",
    ],
    description: buildToolDescription(),
    // biome-ignore lint/complexity/useMaxParams: pi renderResult callback signature is fixed
    renderResult: (result, { isPartial }, theme) => {
      const text = result.content[0]?.type === "text" ? result.content[0].text : "";
      if (!text) return new Text("", 0, 0);
      if (isPartial) return new Text(theme.fg("dim", text), 0, 0);
      const lines = text.split("\n");
      const header = lines[0] ?? "";
      const lineCount = lines.length - 1;
      const icon =
        header.includes("error") || header.includes("Error") ? theme.fg("error", "✗") : theme.fg("success", "✓");
      let rendered = `${icon} ${theme.fg("dim", header)}`;
      if (lineCount > 1) rendered += `\n  ${theme.fg("dim", `${lineCount} lines delivered to agent`)}`;
      return new Text(rendered, 0, 0);
    },
    parameters: Type.Object({
      action: StringEnum(["start", "execute", "continue", "status"] as const, { description: "Workflow action" }),
      workflow_type: Type.Optional(Type.String({ description: "Which workflow (for start)" })),
      description: Type.Optional(Type.String({ description: "Task description (for start)" })),
      tasks: Type.Optional(
        Type.Array(Type.String(), {
          description: "Tasks for current phase (for execute). 1 = single agent, multiple = parallel.",
        }),
      ),
    }),
    // biome-ignore lint/complexity/useMaxParams: pi tool execute callback signature is fixed
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      if (params.action === "status") return buildWorkflowStatusText({ ctx, activeWorkflowId });
      if (params.action === "continue") return handleContinue({ ctx });
      if (params.action === "execute") return handleExecute({ tasks: params.tasks, ctx, signal, onUpdate });
      return handleStart({ typeName: params.workflow_type, desc: params.description ?? "", ctx });
    },
  });

  // ── Action Handlers ──────────────────────────────────────────────

  function handleStart({ typeName, desc, ctx }: { typeName: string | undefined; desc: string; ctx: ExtensionContext }) {
    if (!typeName) return textResult("Error: workflow_type is required.", true);
    const definition = workflows.get(typeName);
    if (!definition)
      return textResult(`Unknown workflow: "${typeName}". Available: ${Array.from(workflows.keys()).join(", ")}`, true);
    if (activeWorkflowId)
      return textResult(`A workflow is already active (${activeWorkflowId}). Use action "status".`, true);

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

    return textResult(`Workflow "${definition.name}" started.\n\nPhases:\n${buildPhaseSummary()}\n${buildPhaseInfo()}`);
  }

  async function handleExecute({
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
    if (!activeWorkflowId || !activeDefinition || !activeState || !deps?.manager) {
      return textResult("No active workflow. Use action 'start' first.", true);
    }
    if (!tasks || tasks.length === 0) {
      return textResult("Error: tasks array is required for execute.", true);
    }

    const stopProgress = onUpdate
      ? startProgressTimer({ getState: () => activeState, getManager: () => deps?.manager, onUpdate })
      : undefined;
    doRefreshWidget(ctx);

    try {
      const outcome = await executeSinglePhase({
        definition: activeDefinition,
        state: activeState,
        cwd: ctx.cwd,
        workflowId: activeWorkflowId,
        pi,
        ctx,
        manager: deps.manager,
        signal,
        agentActivity: deps.agentActivity,
        tasks,
      });

      doRefreshWidget(ctx);

      if (outcome.type === "workflow-complete") {
        const handoffs = listHandoffs({ cwd: ctx.cwd, workflowId: activeWorkflowId });
        const findings = formatFindings(handoffs);
        const result = `Workflow completed: ${outcome.exitReason}.\n${findings}`;
        activeWorkflowId = undefined;
        activeDefinition = undefined;
        activeState = undefined;
        doRefreshWidget(ctx);
        return textResult(result);
      }
      if (outcome.type === "error") {
        const handoffs = listHandoffs({ cwd: ctx.cwd, workflowId: activeWorkflowId });
        return textResult(`Workflow error: ${outcome.error}\n${formatFindings(handoffs)}`, true);
      }

      // Phase complete — return findings + next phase info
      const handoffs = listHandoffs({ cwd: ctx.cwd, workflowId: activeWorkflowId });
      const latestHandoffs = handoffs.filter(
        (h) =>
          h.phase ===
            activeDefinition!.phases.find(
              (p) => p.name !== activeState!.currentPhase && activeState!.phases[p.name]?.status === "complete",
            )?.name || handoffs.indexOf(h) >= handoffs.length - (tasks?.length ?? 1),
      );
      const findings = formatFindings(latestHandoffs.length > 0 ? latestHandoffs : handoffs.slice(-1));

      // Check if next phase is a gate
      const nextPhase = activeDefinition.phases.find((p) => p.name === activeState!.currentPhase);
      if (nextPhase?.mode === "gate") {
        return textResult(
          `Phase completed.\n${findings}\n\nNext: approval gate "${nextPhase.name}". ${nextPhase.description}\nReview the findings and call Workflow({ action: "continue" }) to proceed.`,
        );
      }

      return textResult(`Phase completed.\n${findings}\n${buildPhaseInfo()}`);
    } finally {
      stopProgress?.();
    }
  }

  function handleContinue({ ctx }: { ctx: ExtensionContext }) {
    if (!activeWorkflowId || !activeDefinition || !activeState) {
      return textResult("No active workflow to continue.", true);
    }

    const currentPhase = activeDefinition.phases.find((p) => p.name === activeState!.currentPhase);
    if (currentPhase?.mode === "gate") {
      updatePhaseStatus({
        state: activeState,
        phase: activeState.currentPhase,
        status: "complete",
        onEvent: (e) => emitEvent(ctx.cwd, e),
      });
      emitEvent(ctx.cwd, { type: "approval", phase: activeState.currentPhase, decision: "approved", ts: Date.now() });

      const nextIndex = activeDefinition.phases.findIndex((p) => p.name === activeState!.currentPhase) + 1;
      const nextPhase = activeDefinition.phases[nextIndex];
      if (!nextPhase) {
        activeState.exitReason = "clean";
        activeState.completedAt = Date.now();
        writeState({ cwd: ctx.cwd, workflowId: activeWorkflowId, state: activeState });
        const handoffs = listHandoffs({ cwd: ctx.cwd, workflowId: activeWorkflowId });
        activeWorkflowId = undefined;
        activeDefinition = undefined;
        activeState = undefined;
        doRefreshWidget(ctx);
        return textResult(`Workflow completed.\n${formatFindings(handoffs)}`);
      }
      activeState.currentPhase = nextPhase.name;
      writeState({ cwd: ctx.cwd, workflowId: activeWorkflowId, state: activeState });
      doRefreshWidget(ctx);
      return textResult(`Gate approved.\n${buildPhaseInfo()}`);
    }

    return textResult("Current phase is not a gate. Use execute to run the current phase.", true);
  }

  // ── Helpers ──────────────────────────────────────────────────────

  function formatFindings(handoffs: readonly AgentHandoff[]) {
    if (handoffs.length === 0) return "";
    return handoffs.map((h) => `\n## ${h.role} (${h.phase})\n${h.findings}`).join("\n");
  }

  function computeLiveStats(mgr: AgentManager | undefined) {
    if (!mgr) return { liveTokens: 0, agentCount: 0, doneCount: 0 };
    const agents = mgr.listAgents();
    let liveTokens = 0;
    let doneCount = 0;
    for (const a of agents) {
      if (a.session) {
        try {
          liveTokens += a.session.getSessionStats().tokens.total;
        } catch {
          /* */
        }
      }
      if (a.status !== "running" && a.status !== "queued") doneCount++;
    }
    return { liveTokens, agentCount: agents.length, doneCount };
  }

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
      const stats = computeLiveStats(getManager());
      const liveTokens = state.tokens.total + stats.liveTokens;
      onUpdate({
        content: [
          {
            type: "text",
            text: buildStatusText({ state, liveTokens, agentCount: stats.agentCount, doneCount: stats.doneCount }),
          },
        ],
        details: {},
      });
    }, PROGRESS_INTERVAL_MS);
    return () => clearInterval(timer);
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
