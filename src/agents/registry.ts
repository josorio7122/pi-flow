/**
 * registry.ts — Unified agent type registry.
 *
 * Factory that creates a registry merging embedded defaults with user-defined agents.
 * User agents override defaults with the same name. Disabled agents are kept but excluded from spawning.
 */

import type { AgentTool } from "@mariozechner/pi-agent-core";
import {
  createBashTool,
  createEditTool,
  createFindTool,
  createGrepTool,
  createLsTool,
  createReadTool,
  createWriteTool,
} from "@mariozechner/pi-coding-agent";
import type { AgentConfig } from "../types.js";
import { DEFAULT_AGENTS } from "./defaults.js";

// biome-ignore lint/suspicious/noExplicitAny: AgentTool generic requires TSchema subtype; each tool has a different concrete schema
type ToolFactory = (cwd: string) => AgentTool<any>;

const TOOL_FACTORIES: Record<string, ToolFactory> = {
  read: (cwd) => createReadTool(cwd),
  bash: (cwd) => createBashTool(cwd),
  edit: (cwd) => createEditTool(cwd),
  write: (cwd) => createWriteTool(cwd),
  grep: (cwd) => createGrepTool(cwd),
  find: (cwd) => createFindTool(cwd),
  ls: (cwd) => createLsTool(cwd),
};

/** All known built-in tool names, derived from the factory registry. */
export const BUILTIN_TOOL_NAMES = Object.keys(TOOL_FACTORIES);

export function createRegistry() {
  const agents = new Map<string, AgentConfig>();

  function resolveKey(name: string) {
    if (agents.has(name)) return name;
    const lower = name.toLowerCase();
    for (const key of agents.keys()) {
      if (key.toLowerCase() === lower) return key;
    }
    return undefined;
  }

  return {
    register(userAgents: Map<string, AgentConfig>) {
      agents.clear();
      for (const [name, config] of DEFAULT_AGENTS) {
        agents.set(name, config);
      }
      for (const [name, config] of userAgents) {
        agents.set(name, config);
      }
    },

    resolveType(name: string) {
      return resolveKey(name);
    },

    getAgentConfig(name: string) {
      const key = resolveKey(name);
      return key ? agents.get(key) : undefined;
    },

    getAvailableTypes() {
      return [...agents.entries()]
        .filter(([_, config]) => config.enabled !== false)
        .map(([name]) => name);
    },

    getAllTypes() {
      return [...agents.keys()];
    },

    getDefaultAgentNames() {
      return [...agents.entries()]
        .filter(([_, config]) => config.isDefault === true)
        .map(([name]) => name);
    },

    getUserAgentNames() {
      return [...agents.entries()]
        .filter(([_, config]) => config.isDefault !== true)
        .map(([name]) => name);
    },

    isValidType(type: string) {
      const key = resolveKey(type);
      if (!key) return false;
      return agents.get(key)?.enabled !== false;
    },

    // biome-ignore lint/suspicious/noExplicitAny: heterogeneous tool array requires any
    getMemoryTools(cwd: string, existingToolNames: Set<string>): AgentTool<any>[] {
      return ["read", "write", "edit"]
        .filter(n => !existingToolNames.has(n) && n in TOOL_FACTORIES)
        .map(n => TOOL_FACTORIES[n]!(cwd));
    },

    // biome-ignore lint/suspicious/noExplicitAny: heterogeneous tool array requires any
    getReadOnlyMemoryTools(cwd: string, existingToolNames: Set<string>): AgentTool<any>[] {
      return ["read"]
        .filter(n => !existingToolNames.has(n) && n in TOOL_FACTORIES)
        .map(n => TOOL_FACTORIES[n]!(cwd));
    },

    // biome-ignore lint/suspicious/noExplicitAny: heterogeneous tool array requires any
    getToolsForType(type: string, cwd: string): AgentTool<any>[] {
      const key = resolveKey(type);
      const raw = key ? agents.get(key) : undefined;
      const config = raw?.enabled !== false ? raw : undefined;
      const toolNames = config?.builtinToolNames?.length ? config.builtinToolNames : BUILTIN_TOOL_NAMES;
      return toolNames.filter((n) => n in TOOL_FACTORIES).map((n) => TOOL_FACTORIES[n]!(cwd));
    },

    getConfig(type: string) {
      const key = resolveKey(type);
      const config = key ? agents.get(key) : undefined;
      if (config && config.enabled !== false) {
        return {
          displayName: config.displayName ?? config.name,
          description: config.description,
          builtinToolNames: config.builtinToolNames ?? BUILTIN_TOOL_NAMES,
          extensions: config.extensions,
          skills: config.skills,
          promptMode: config.promptMode,
        };
      }

      const gp = agents.get("general-purpose");
      if (gp && gp.enabled !== false) {
        return {
          displayName: gp.displayName ?? gp.name,
          description: gp.description,
          builtinToolNames: gp.builtinToolNames ?? BUILTIN_TOOL_NAMES,
          extensions: gp.extensions,
          skills: gp.skills,
          promptMode: gp.promptMode,
        };
      }

      return {
        displayName: "Agent",
        description: "General-purpose agent for complex, multi-step tasks",
        builtinToolNames: BUILTIN_TOOL_NAMES,
        extensions: true as const,
        skills: true as const,
        promptMode: "append" as const,
      };
    },
  };
}

export type Registry = ReturnType<typeof createRegistry>;
