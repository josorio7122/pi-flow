/**
 * Shared state passed to feature modules extracted from index.ts.
 * Replaces closure-based sharing with explicit dependency injection.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import type { AgentRecord } from "../types.js";
import type { AgentActivity } from "../ui/formatters.js";
import type { AgentWidget } from "../ui/widget.js";
import type { AgentManager } from "./manager.js";
import type { Registry } from "./registry.js";
import type { RunnerSettings } from "./runner.js";

export interface AgentContext {
  pi: ExtensionAPI;
  manager: AgentManager;
  registry: Registry;
  widget: AgentWidget;
  agentActivity: Map<string, AgentActivity>;
  runnerSettings: RunnerSettings;
  reloadCustomAgents: () => void;
}

export interface NotificationSystem {
  scheduleNudge: (key: string, send: () => void) => void;
  cancelNudge: (key: string) => void;
  sendIndividualNudge: (record: AgentRecord) => void;
}

export interface BatchSystem {
  addToBatch: (id: string, joinMode: string) => void;
  isInBatch: (id: string) => boolean;
  getDefaultJoinMode: () => string;
  setDefaultJoinMode: (mode: string) => void;
}
