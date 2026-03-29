/**
 * pi-agents — A pi extension providing Claude Code-style autonomous sub-agents.
 *
 * Tools:
 *   Agent             — LLM-callable: spawn a sub-agent
 *   get_subagent_result  — LLM-callable: check background agent status/result
 *   steer_subagent       — LLM-callable: send a steering message to a running agent
 *
 * Commands:
 *   /agents                 — Interactive agent management menu
 */

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { createBatchSystem } from "./agents/batch.js";
import { loadCustomAgents } from "./agents/custom.js";
import { createAgentManager } from "./agents/manager.js";
import { createNotificationSystem, registerMessageRenderer } from "./agents/notification.js";
import { createRegistry } from "./agents/registry.js";
import { createRunnerSettings } from "./agents/runner.js";
import { registerAgentTool } from "./agents/tools/agent-tool.js";
import { registerResultTool } from "./agents/tools/result-tool.js";
import { registerSteerTool } from "./agents/tools/steer-tool.js";
import { registerAgentsCommand } from "./extension/command.js";
import { createGroupJoinManager } from "./extension/group-join.js";
import { buildNotificationDetails, formatTaskNotification } from "./extension/helpers.js";
import { registerRpcHandlers } from "./extension/rpc.js";
import { type AgentRecord, type NotificationDetails } from "./types.js";
import { type AgentActivity } from "./ui/formatters.js";
import { AgentWidget } from "./ui/widget.js";
import { registerWorkflowExtension } from "./workflow/integration.js";

export default function (pi: ExtensionAPI) {
  const runnerSettings = createRunnerSettings();
  const registry = createRegistry();

  // ---- Message renderer + notifications ----
  registerMessageRenderer(pi);

  /** Reload agents from .pi/agents/*.md and merge with defaults (called on init and each Agent invocation). */
  const reloadCustomAgents = () => {
    const userAgents = loadCustomAgents(process.cwd());
    registry.register(userAgents);
  };

  // Initial load
  reloadCustomAgents();

  // ---- Agent activity tracking ----
  const agentActivity = new Map<string, AgentActivity>();
  // Notifications created after widget (line ~261), but referenced by manager callbacks.
  // Use a late-bound wrapper so the closure captures the variable, not the initial value.
  let notifications: ReturnType<typeof createNotificationSystem>;

  // ---- Group join manager ----
  const groupJoin = createGroupJoinManager((records, partial) => {
    for (const r of records) {
      agentActivity.delete(r.id);
      widget.markFinished(r.id);
    }

    const groupKey = `group:${records.map((r) => r.id).join(",")}`;
    notifications.scheduleNudge(groupKey, () => {
      // Re-check at send time
      const unconsumed = records.filter((r) => !r.resultConsumed);
      if (unconsumed.length === 0) {
        widget.update();
        return;
      }

      const notifications = unconsumed.map((r) => formatTaskNotification(r, 300)).join("\n\n");
      const label = partial
        ? `${unconsumed.length} agent(s) finished (partial — others still running)`
        : `${unconsumed.length} agent(s) finished`;

      const [first, ...rest] = unconsumed;
      if (!first) return;
      const details = buildNotificationDetails({
        record: first,
        resultMaxLen: 300,
        activity: agentActivity.get(first.id),
      });
      if (rest.length > 0) {
        details.others = rest.map((r) =>
          buildNotificationDetails({ record: r, resultMaxLen: 300, activity: agentActivity.get(r.id) }),
        );
      }

      pi.sendMessage<NotificationDetails>(
        {
          customType: "subagent-notification",
          content: `Background agent group completed: ${label}\n\n${notifications}\n\nUse get_subagent_result for full output.`,
          display: true,
          details,
        },
        { deliverAs: "followUp", triggerTurn: true },
      );
    });
    widget.update();
  }, 30_000);

  /** Helper: build event data for lifecycle events from an AgentRecord. */
  function buildEventData(record: AgentRecord) {
    const durationMs = record.completedAt ? record.completedAt - record.startedAt : Date.now() - record.startedAt;
    let tokens: { input: number; output: number; total: number } | undefined;
    try {
      if (record.session) {
        const stats = record.session.getSessionStats();
        tokens = {
          input: stats.tokens?.input ?? 0,
          output: stats.tokens?.output ?? 0,
          total: stats.tokens?.total ?? 0,
        };
      }
    } catch {
      /* session stats unavailable */
    }
    return {
      id: record.id,
      type: record.type,
      description: record.description,
      result: record.result,
      error: record.error,
      status: record.status,
      toolUses: record.toolUses,
      durationMs,
      tokens,
    };
  }

  // Background completion: route through group join or send individual nudge
  const manager = createAgentManager({
    onComplete: (record) => {
      // Emit lifecycle event based on terminal status
      const isError = record.status === "error" || record.status === "stopped" || record.status === "aborted";
      const eventData = buildEventData(record);
      if (isError) {
        pi.events.emit("subagents:failed", eventData);
      } else {
        pi.events.emit("subagents:completed", eventData);
      }

      // Persist final record for cross-extension history reconstruction
      pi.appendEntry("subagents:record", {
        id: record.id,
        type: record.type,
        description: record.description,
        status: record.status,
        result: record.result,
        error: record.error,
        startedAt: record.startedAt,
        completedAt: record.completedAt,
      });

      // Skip notification if result was already consumed via get_subagent_result
      if (record.resultConsumed) {
        agentActivity.delete(record.id);
        widget.markFinished(record.id);
        widget.update();
        return;
      }

      // If this agent is pending batch finalization (debounce window still open),
      // don't send an individual nudge — batch will pick it up retroactively.
      if (batch.isInBatch(record.id)) {
        widget.update();
        return;
      }

      const result = groupJoin.onAgentComplete(record);
      if (result === "pass") {
        notifications.sendIndividualNudge(record);
      }
      // 'held' → do nothing, group will fire later
      // 'delivered' → group callback already fired
      widget.update();
    },
    onStart: (record) => {
      // Emit started event when agent transitions to running (including from queue)
      pi.events.emit("subagents:started", {
        id: record.id,
        type: record.type,
        description: record.description,
      });
    },
  });
  manager.setRunnerSettings(runnerSettings);
  manager.setRegistry(registry);

  // Expose manager via Symbol.for() global registry for cross-package access.
  // Standard Node.js pattern for cross-package singletons (used by OpenTelemetry, etc.).
  const MANAGER_KEY = Symbol.for("pi-flow:manager");
  (globalThis as Record<symbol, unknown>)[MANAGER_KEY] = {
    waitForAll: () => manager.waitForAll(),
    hasRunning: () => manager.hasRunning(),
    spawn: (piRef: unknown, ctx: unknown, type: string, prompt: string, options: unknown) =>
      manager.spawn({ pi: piRef as ExtensionAPI, ctx: ctx as ExtensionContext, type, prompt, options } as Parameters<
        typeof manager.spawn
      >[0]),
    getRecord: (id: string) => manager.getRecord(id),
  };

  // --- Cross-extension RPC via pi.events ---
  let currentCtx: ExtensionContext | undefined;

  // Capture ctx from session_start for RPC spawn handler
  pi.on("session_start", async (_event, ctx) => {
    currentCtx = ctx;
    manager.clearCompleted(); // preserve existing behavior
  });

  pi.on("session_switch", () => {
    manager.clearCompleted();
  });

  const {
    unsubPing: unsubPingRpc,
    unsubSpawn: unsubSpawnRpc,
    unsubStop: unsubStopRpc,
  } = registerRpcHandlers({
    events: pi.events,
    pi,
    getCtx: () => currentCtx,
    manager,
  });

  // Broadcast readiness so extensions loaded after us can discover us
  pi.events.emit("subagents:ready", {});

  // On shutdown, abort all agents immediately and clean up.
  // If the session is going down, there's nothing left to consume agent results.
  pi.on("session_shutdown", async () => {
    unsubSpawnRpc();
    unsubStopRpc();
    unsubPingRpc();
    currentCtx = undefined;
    delete (globalThis as Record<symbol, unknown>)[MANAGER_KEY];
    manager.abortAll();
    notifications.disposeAll();
    manager.dispose();
  });

  // Live widget: show running agents above editor
  const widget = new AgentWidget(manager, agentActivity, registry);
  notifications = createNotificationSystem({ pi, widget, agentActivity });

  // ---- Batch tracking ----
  const batch = createBatchSystem({ groupJoin, manager, notifications });

  // Grab UI context from first tool execution + clear lingering widget on new turn
  pi.on("tool_execution_start", async (_event, ctx) => {
    widget.setUICtx(ctx.ui);
    widget.onTurnStart();
  });

  /** Build the full type list text dynamically from the unified registry. */
  const buildTypeListText = () => {
    const defaultNames = registry.getDefaultAgentNames();
    const userNames = registry.getUserAgentNames();

    const defaultDescs = defaultNames.map((name) => {
      const cfg = registry.getAgentConfig(name);
      const modelSuffix = cfg?.model ? ` (${getModelLabelFromConfig(cfg.model)})` : "";
      return `- ${name}: ${cfg?.description ?? name}${modelSuffix}`;
    });

    const customDescs = userNames.map((name) => {
      const cfg = registry.getAgentConfig(name);
      return `- ${name}: ${cfg?.description ?? name}`;
    });

    return [
      "Default agents:",
      ...defaultDescs,
      ...(customDescs.length > 0 ? ["", "Custom agents:", ...customDescs] : []),
      "",
      "Custom agents can be defined in .pi/agents/<name>.md (project) or ~/.pi/agent/agents/<name>.md (global) — they are picked up automatically. Project-level agents override global ones. Creating a .md file with the same name as a default agent overrides it.",
    ].join("\n");
  };

  /** Derive a short model label from a model string. */
  function getModelLabelFromConfig(model: string) {
    // Strip provider prefix (e.g. "anthropic/claude-sonnet-4-6" → "claude-sonnet-4-6")
    const name = model.includes("/") ? model.split("/").pop()! : model;
    // Strip trailing date suffix (e.g. "claude-haiku-4-5-20251001" → "claude-haiku-4-5")
    return name.replace(/-\d{8}$/, "");
  }

  const typeListText = buildTypeListText();

  // ---- Tools ----
  registerAgentTool({
    pi,
    manager,
    registry,
    widget,
    agentActivity,
    runnerSettings,
    batch,
    reloadCustomAgents,
    typeListText,
  });
  registerResultTool({ pi, manager, registry, notifications });
  registerSteerTool({ pi, manager });

  // ---- /agents interactive menu ----
  registerAgentsCommand({
    pi,
    manager,
    agentActivity,
    reloadCustomAgents,
    getDefaultJoinMode: batch.getDefaultJoinMode,
    setDefaultJoinMode: batch.setDefaultJoinMode,
    runnerSettings,
    registry,
  });

  // ---- Workflow engine ----
  registerWorkflowExtension(pi);
}
