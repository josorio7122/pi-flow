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

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { createBatchSystem } from "./agents/batch.js";
import { loadCustomAgents } from "./agents/custom.js";
import { createGroupJoinCallback, createOnComplete } from "./agents/lifecycle.js";
import { createAgentManager } from "./agents/manager.js";
import { createNotificationSystem, registerMessageRenderer } from "./agents/notification.js";
import { createRegistry } from "./agents/registry.js";
import { createRunnerSettings } from "./agents/runner-types.js";
import { registerAgentTool } from "./agents/tools/agent-tool.js";
import { registerResultTool } from "./agents/tools/result-tool.js";
import { registerSteerTool } from "./agents/tools/steer-tool.js";
import { registerAgentsCommand } from "./extension/command/command.js";
import { createGroupJoinManager } from "./extension/group-join.js";
import { registerRpcHandlers } from "./extension/rpc.js";
import { type AgentActivity } from "./ui/formatters.js";
import { AgentWidget } from "./ui/widget.js";
import { registerWorkflowExtension } from "./workflow/integration.js";

export default function (pi: ExtensionAPI) {
  const extensionRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
  const runnerSettings = createRunnerSettings();
  const registry = createRegistry();

  // ---- Message renderer + notifications ----
  registerMessageRenderer(pi);

  /** Reload agents from .pi/agents/*.md and merge with defaults (called on init and each Agent invocation). */
  const builtinAgentsDir = join(extensionRoot, "agents");
  const reloadCustomAgents = () => {
    const userAgents = loadCustomAgents(process.cwd(), builtinAgentsDir);
    registry.register(userAgents);
  };

  // Initial load
  reloadCustomAgents();

  // ---- Agent activity tracking ----
  const agentActivity = new Map<string, AgentActivity>();
  // Notifications created after widget (line ~261), but referenced by manager callbacks.
  // Use a late-bound wrapper so the closure captures the variable, not the initial value.
  let notifications: ReturnType<typeof createNotificationSystem>;

  // ---- Group join + manager ----
  // Late-bound: groupJoin callback and onComplete reference `notifications` and `batch`
  // which are created after `widget` (which needs `manager`). Use getters to break the cycle.
  const groupJoinCb = createGroupJoinCallback({
    pi,
    agentActivity,
    getWidget: () => widget,
    getNotifications: () => notifications,
  });
  const groupJoin = createGroupJoinManager(groupJoinCb, 30_000);
  const onComplete = createOnComplete({
    pi,
    agentActivity,
    getWidget: () => widget,
    getBatch: () => batch,
    groupJoin,
    getNotifications: () => notifications,
  });

  const manager = createAgentManager({
    onComplete,
    onStart: (record) =>
      pi.events.emit("subagents:started", { id: record.id, type: record.type, description: record.description }),
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
  pi.on("session_start", async (_, ctx) => {
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
  pi.on("tool_execution_start", async (_, ctx) => {
    widget.setUICtx(ctx.ui);
    widget.onTurnStart();
  });

  // ---- Tools ----
  registerAgentTool({ pi, manager, registry, widget, agentActivity, runnerSettings, batch, reloadCustomAgents });
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
  registerWorkflowExtension(pi, join(extensionRoot, "workflows"), { manager });
}
