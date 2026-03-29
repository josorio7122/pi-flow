import type { AgentConfig, IsolationMode, JoinMode, ThinkingLevel } from "./types.js";

interface AgentInvocationParams {
  model?: string | undefined;
  thinking?: string | undefined;
  max_turns?: number | undefined;
  run_in_background?: boolean | undefined;
  inherit_context?: boolean | undefined;
  isolated?: boolean | undefined;
  isolation?: IsolationMode | undefined;
}

export function resolveAgentInvocationConfig(
  agentConfig: AgentConfig | undefined,
  params: AgentInvocationParams,
): {
  modelInput?: string | undefined;
  modelFromParams: boolean;
  thinking?: ThinkingLevel | undefined;
  maxTurns?: number | undefined;
  inheritContext: boolean;
  runInBackground: boolean;
  isolated: boolean;
  isolation?: IsolationMode | undefined;
} {
  return {
    modelInput: agentConfig?.model ?? params.model,
    modelFromParams: agentConfig?.model == null && params.model != null,
    thinking: (agentConfig?.thinking ?? params.thinking) as ThinkingLevel | undefined,
    maxTurns: agentConfig?.maxTurns ?? params.max_turns,
    inheritContext: agentConfig?.inheritContext ?? params.inherit_context ?? false,
    runInBackground: agentConfig?.runInBackground ?? params.run_in_background ?? false,
    isolated: agentConfig?.isolated ?? params.isolated ?? false,
    isolation: agentConfig?.isolation ?? params.isolation,
  };
}

export function resolveJoinMode(defaultJoinMode: JoinMode, runInBackground: boolean): JoinMode | undefined {
  return runInBackground ? defaultJoinMode : undefined;
}
