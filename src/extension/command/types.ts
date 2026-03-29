/**
 * Shared types and helpers for the /agents command.
 */

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ModelRegistry } from "@mariozechner/pi-coding-agent";
import type { AgentManager } from "../../agents/manager.js";
import type { Registry } from "../../agents/registry.js";
import type { RunnerSettings } from "../../agents/runner-types.js";
import { resolveModel } from "../../config/model-resolver.js";
import type { JoinMode } from "../../types.js";
import type { AgentActivity } from "../../ui/formatters.js";

export interface CommandDeps {
  pi: ExtensionAPI;
  manager: AgentManager;
  agentActivity: Map<string, AgentActivity>;
  reloadCustomAgents: () => void;
  getDefaultJoinMode: () => JoinMode;
  setDefaultJoinMode: (mode: JoinMode) => void;
  runnerSettings: RunnerSettings;
  registry: Registry;
}

export const projectAgentsDir = () => join(process.cwd(), ".pi", "agents");
export const personalAgentsDir = () => join(homedir(), ".pi", "agent", "agents");

export function findAgentFile(name: string) {
  const projectPath = join(projectAgentsDir(), `${name}.md`);
  if (existsSync(projectPath)) return { path: projectPath, location: "project" as const };
  const personalPath = join(personalAgentsDir(), `${name}.md`);
  if (existsSync(personalPath)) return { path: personalPath, location: "personal" as const };
  return undefined;
}

export function getModelLabelFromConfig(modelStr: string) {
  const parts = modelStr.split("/");
  const id = parts[parts.length - 1] ?? modelStr;
  if (id.includes("haiku")) return "haiku";
  if (id.includes("sonnet")) return "sonnet";
  if (id.includes("opus")) return "opus";
  return id.length > 20 ? id.slice(0, 17) + "…" : id;
}

export function getModelLabel(type: string, deps: CommandDeps, modelRegistry?: ModelRegistry) {
  const cfg = deps.registry.getAgentConfig(type);
  if (!cfg?.model) return "inherit";
  if (modelRegistry) {
    const resolved = resolveModel(cfg.model, modelRegistry);
    if (typeof resolved === "string") return "inherit";
  }
  return getModelLabelFromConfig(cfg.model);
}
