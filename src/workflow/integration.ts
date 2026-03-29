/**
 * Integration — wire workflow tooling into pi's extension API.
 *
 * Registers:
 * - Workflow tool (LLM-callable)
 * - /flow command (user-callable)
 * - session_start hook (crash recovery)
 * - turn_end hook (widget updates)
 *
 * This is the only workflow file that depends on pi's extension API.
 * All logic is delegated to the pure modules (pipeline, store, etc.).
 */

import { randomUUID } from "node:crypto";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { loadWorkflowDefinitions } from "./loader.js";
import { createWorkflowState } from "./pipeline.js";
import { buildProgressLines, buildStatusText, formatDuration } from "./progress.js";
import { findStalled, formatStalledMessage } from "./recovery.js";
import { appendEvent, initWorkflowDir, listHandoffs, readEvents, readState, writeState } from "./store.js";
import type { WorkflowDefinition, WorkflowEvent } from "./types.js";

const ENTRY_TYPE = "pi-flow:active";
const WIDGET_KEY = "pi-flow";
const STALLED_TIMEOUT_MS = 5 * 60 * 1000;

interface ActiveWorkflowBookmark {
  workflowId: string;
  workflowDir: string;
  startedAt: string;
}

export function registerWorkflowExtension(pi: ExtensionAPI, builtinWorkflowsDir?: string) {
  let workflows = new Map<string, WorkflowDefinition>();
  let activeWorkflowId: string | undefined;
  let activeDefinition: WorkflowDefinition | undefined;
  let _lastCtx: ExtensionContext | undefined;

  function emitEvent(cwd: string, event: WorkflowEvent) {
    if (activeWorkflowId) {
      appendEvent(cwd, activeWorkflowId, event);
    }
  }

  function refreshWidget(ctx: ExtensionContext) {
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

    return `Trigger a structured workflow for complex multi-step tasks.

Available workflows:
${listing}

Use action "start" to begin a new workflow.
Use action "continue" to resume after an approval gate or crash recovery.
Use action "status" to check the current workflow state.`;
  }

  pi.registerTool({
    name: "Workflow",
    label: "Workflow",
    description: buildToolDescription(),
    parameters: Type.Object({
      action: Type.String({
        description: '"start" to begin, "continue" to resume past a gate, "status" to check progress',
      }),
      workflow_type: Type.Optional(Type.String({ description: "Which workflow to run (required for start)" })),
      description: Type.Optional(Type.String({ description: "What the user wants done (required for start)" })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      _lastCtx = ctx;

      if (params.action === "status") {
        return workflowStatusResult(ctx);
      }

      if (params.action === "continue") {
        return workflowContinueResult(ctx);
      }

      // action: "start"
      const typeName = params.workflow_type;
      const desc = params.description ?? "";

      if (!typeName) {
        return textResult("Error: workflow_type is required for action 'start'.", true);
      }

      const definition = workflows.get(typeName);
      if (!definition) {
        const available = Array.from(workflows.keys()).join(", ");
        return textResult(`Unknown workflow: "${typeName}". Available: ${available}`, true);
      }

      if (activeWorkflowId) {
        return textResult(
          `A workflow is already active (${activeWorkflowId}). Use action "status" to check it or complete it first.`,
          true,
        );
      }

      // Create workflow
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

      emitEvent(ctx.cwd, {
        type: "workflow_start",
        workflowType: definition.name,
        description: desc,
        ts: Date.now(),
      });

      refreshWidget(ctx);

      const phaseList = definition.phases.map((p) => `${p.name} (${p.mode})`).join(" → ");
      return textResult(
        `Workflow "${definition.name}" started (${workflowId}).\n\nPhases: ${phaseList}\n\n` +
          `Description: ${desc}\n\n` +
          (definition.orchestratorInstructions ? `Instructions:\n${definition.orchestratorInstructions}\n\n` : "") +
          `The first phase is "${definition.phases[0]?.name}". ` +
          `Spawn the appropriate agent to begin.`,
      );
    },
  });

  // ── /flow Command ──────────────────────────────────────────────

  pi.registerCommand("flow", {
    description: "View workflow progress and manage active workflows",
    handler: async (_args, ctx) => {
      _lastCtx = ctx;

      if (!activeWorkflowId) {
        ctx.ui.notify("No active workflow. The LLM can start one with the Workflow tool.", "info");
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
          (p) => `  ${p.status === "complete" ? "✓" : p.status === "running" ? "●" : "○"} ${p.phase} (${p.status})`,
        ),
        "",
        `Handoffs: ${handoffs.length} | Events: ${events.length}`,
      ];

      const actions = ["Close", "Abort workflow"];
      const choice = await ctx.ui.select(lines.join("\n"), actions);

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
          refreshWidget(ctx);
          ctx.ui.notify("Workflow aborted.", "info");
        }
      }
    },
  });

  // ── Hooks ──────────────────────────────────────────────────────

  pi.on("session_start", async (_event, ctx) => {
    _lastCtx = ctx;
    workflows = loadWorkflowDefinitions(ctx.cwd, builtinWorkflowsDir);

    // Recovery: scan entries for active workflow bookmark
    const entries = ctx.sessionManager.getEntries();
    const bookmark = findLatestBookmark(entries);
    if (!bookmark) return;

    const state = readState(ctx.cwd, bookmark.workflowId);
    if (!state || state.completedAt) return;

    activeWorkflowId = bookmark.workflowId;
    activeDefinition = workflows.get(state.definitionName);

    // Check for stalled agents
    const stalled = findStalled({ agents: state.activeAgents, timeoutMs: STALLED_TIMEOUT_MS });
    for (const agent of stalled) {
      ctx.ui.notify(`⚠ ${formatStalledMessage(agent)}`, "warning");
    }

    if (stalled.length > 0) {
      ctx.ui.notify(`Workflow "${state.type}" was interrupted. Say "resume workflow" to continue.`, "warning");
    }

    refreshWidget(ctx);
  });

  pi.on("turn_end", async (_event, ctx) => {
    _lastCtx = ctx;
    if (activeWorkflowId) refreshWidget(ctx);
  });

  // ── Helpers ────────────────────────────────────────────────────

  function workflowStatusResult(ctx: ExtensionContext) {
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

  function workflowContinueResult(ctx: ExtensionContext) {
    if (!activeWorkflowId || !activeDefinition) {
      return textResult("No active workflow to continue.", true);
    }
    const state = readState(ctx.cwd, activeWorkflowId);
    if (!state) return textResult("Workflow state not found.", true);

    const currentPhase = activeDefinition.phases.find((p) => p.name === state.currentPhase);
    if (!currentPhase) return textResult("Current phase not found in definition.", true);

    return textResult(
      `Workflow "${state.type}" resumed at phase "${state.currentPhase}" (${currentPhase.mode}).\n` +
        `Continue with the ${currentPhase.role ?? "next"} agent.`,
    );
  }

  function textResult(text: string, isError = false) {
    return {
      content: [{ type: "text" as const, text }],
      details: {},
      ...(isError ? { isError: true } : {}),
    };
  }

  return {
    getActiveWorkflowId: () => activeWorkflowId,
    getWorkflows: () => workflows,
  };
}

// ── Entry Scanning ───────────────────────────────────────────────────

function findLatestBookmark(entries: readonly { type: string; customType?: string; data?: unknown }[]) {
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (entry?.type === "custom" && entry.customType === ENTRY_TYPE && entry.data) {
      return entry.data as ActiveWorkflowBookmark;
    }
  }
  return null;
}
