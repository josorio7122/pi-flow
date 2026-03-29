/**
 * Agent session builder — resolves tools, memory, skills, prompt, model,
 * creates the AgentSession, filters tools, and binds extensions.
 */

import type { ThinkingLevel } from "@mariozechner/pi-agent-core";
import type { Api, Model } from "@mariozechner/pi-ai";
import type { AgentSession, ExtensionContext, ModelRegistry } from "@mariozechner/pi-coding-agent";
import {
  createAgentSession,
  DefaultResourceLoader,
  type ExtensionAPI,
  SessionManager,
  SettingsManager,
} from "@mariozechner/pi-coding-agent";
import { buildAgentPrompt, type PromptExtras } from "../config/prompts.js";
import { preloadSkills } from "../config/skill-loader.js";
import { detectEnv } from "../infra/env.js";
import { buildMemoryBlock, buildReadOnlyMemoryBlock } from "../infra/memory.js";
import type { AgentConfig, SubagentType } from "../types.js";
import type { Registry } from "./registry.js";

const EXCLUDED_TOOL_NAMES = ["Agent", "get_subagent_result", "steer_subagent"];

function resolveDefaultModel({
  parentModel,
  registry,
  configModel,
}: {
  parentModel: Model<Api> | undefined;
  registry: ModelRegistry;
  configModel?: string | undefined;
}) {
  if (!configModel) return parentModel;
  const slashIdx = configModel.indexOf("/");
  if (slashIdx !== -1) {
    const provider = configModel.slice(0, slashIdx);
    const modelId = configModel.slice(slashIdx + 1);
    const available = registry.getAvailable?.();
    const availableKeys = available
      ? new Set(available.map((m: { provider: string; id: string }) => `${m.provider}/${m.id}`))
      : undefined;
    const isAvailable = (p: string, id: string) => !availableKeys || availableKeys.has(`${p}/${id}`);
    const found = registry.find(provider, modelId);
    if (found && isAvailable(provider, modelId)) return found;
  }
  return parentModel;
}

export interface SessionResult {
  session: AgentSession;
  agentConfig: AgentConfig | undefined;
  effectiveCwd: string;
}

export async function buildAgentSession({
  ctx,
  type,
  options,
}: {
  ctx: ExtensionContext;
  type: SubagentType;
  options: {
    pi: ExtensionAPI;
    registry: Registry;
    cwd?: string | undefined;
    model?: Model<Api> | undefined;
    isolated?: boolean | undefined;
    thinkingLevel?: ThinkingLevel | undefined;
    disallowedTools?: Set<string> | undefined;
    onToolActivity?: ((activity: { type: "start" | "end"; toolName: string }) => void) | undefined;
  };
}): Promise<SessionResult> {
  const config = options.registry.getConfig(type);
  const agentConfig = options.registry.getAgentConfig(type);
  const effectiveCwd = options.cwd ?? ctx.cwd;
  const env = await detectEnv(options.pi, effectiveCwd);
  const parentSystemPrompt = ctx.getSystemPrompt();

  const extras: PromptExtras = {};
  const extensions = options.isolated ? false : config.extensions;
  const skills = options.isolated ? false : config.skills;

  if (Array.isArray(skills)) {
    const loaded = preloadSkills(skills, effectiveCwd);
    if (loaded.length > 0) extras.skillBlocks = loaded;
  }

  let tools = options.registry.getToolsForType(type, effectiveCwd);

  if (agentConfig?.memory) {
    const existingNames = new Set(tools.map((t) => t.name));
    const denied = agentConfig.disallowedTools ? new Set(agentConfig.disallowedTools) : undefined;
    const effectivelyHas = (name: string) => existingNames.has(name) && !denied?.has(name);
    const hasWriteTools = effectivelyHas("write") || effectivelyHas("edit");

    if (hasWriteTools) {
      const memTools = options.registry.getMemoryTools(effectiveCwd, existingNames);
      if (memTools.length > 0) tools = [...tools, ...memTools];
      extras.memoryBlock = buildMemoryBlock({
        agentName: agentConfig.name,
        scope: agentConfig.memory,
        cwd: effectiveCwd,
      });
    } else {
      if (!existingNames.has("read")) {
        const readTools = options.registry.getReadOnlyMemoryTools(effectiveCwd, existingNames);
        if (readTools.length > 0) tools = [...tools, ...readTools];
      }
      extras.memoryBlock = buildReadOnlyMemoryBlock({
        agentName: agentConfig.name,
        scope: agentConfig.memory,
        cwd: effectiveCwd,
      });
    }
  }

  const systemPrompt = agentConfig
    ? buildAgentPrompt({ config: agentConfig, cwd: effectiveCwd, env, parentSystemPrompt, extras })
    : buildAgentPrompt({
        config: {
          name: type,
          description: "General-purpose agent",
          systemPrompt: "",
          promptMode: "append",
          extensions: true,
          skills: true,
          inheritContext: false,
          runInBackground: false,
          isolated: false,
        },
        cwd: effectiveCwd,
        env,
        parentSystemPrompt,
        extras,
      });

  const noSkills = skills === false || Array.isArray(skills);
  const loader = new DefaultResourceLoader({
    cwd: effectiveCwd,
    noExtensions: extensions === false,
    noSkills,
    noPromptTemplates: true,
    noThemes: true,
    systemPromptOverride: () => systemPrompt,
  });
  await loader.reload();

  const model =
    options.model ??
    resolveDefaultModel({ parentModel: ctx.model, registry: ctx.modelRegistry, configModel: agentConfig?.model });
  const thinkingLevel = options.thinkingLevel ?? agentConfig?.thinking;

  const sessionOpts: Record<string, unknown> = {
    cwd: effectiveCwd,
    sessionManager: SessionManager.inMemory(effectiveCwd),
    settingsManager: SettingsManager.create(),
    modelRegistry: ctx.modelRegistry,
    model,
    tools,
    resourceLoader: loader,
  };
  if (thinkingLevel) sessionOpts.thinkingLevel = thinkingLevel;

  const { session } = await createAgentSession(sessionOpts as Parameters<typeof createAgentSession>[0]);

  const disallowedSet = agentConfig?.disallowedTools ? new Set(agentConfig.disallowedTools) : undefined;

  if (extensions !== false) {
    const builtinToolNames = new Set(tools.map((t) => t.name));
    const activeTools = session.getActiveToolNames().filter((t) => {
      if (EXCLUDED_TOOL_NAMES.includes(t)) return false;
      if (disallowedSet?.has(t)) return false;
      if (builtinToolNames.has(t)) return true;
      if (Array.isArray(extensions)) return extensions.some((ext) => t.startsWith(ext) || t.includes(ext));
      return true;
    });
    session.setActiveToolsByName(activeTools);
  } else if (disallowedSet) {
    const activeTools = session.getActiveToolNames().filter((t) => !disallowedSet.has(t));
    session.setActiveToolsByName(activeTools);
  }

  await session.bindExtensions({
    onError: (err) => {
      options.onToolActivity?.({ type: "end", toolName: `extension-error:${err.extensionPath}` });
    },
  });

  return { session, agentConfig, effectiveCwd };
}
