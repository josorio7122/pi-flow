import type { ThinkingLevel } from "@mariozechner/pi-agent-core";
import type { AgentConfig, IsolationMode, JoinMode } from "../types.js";

export const VALID_THINKING = new Set<string>(["off", "minimal", "low", "medium", "high", "xhigh"]);

export function parseThinking(val: string | undefined) {
  if (!val) return undefined;
  return VALID_THINKING.has(val) ? (val as ThinkingLevel) : undefined;
}

interface AgentInvocationParams {
  model?: string | undefined;
  thinking?: string | undefined;
  max_turns?: number | undefined;
  run_in_background?: boolean | undefined;
  inherit_context?: boolean | undefined;
  isolated?: boolean | undefined;
  isolation?: IsolationMode | undefined;
}

export function resolveAgentInvocationConfig(agentConfig: AgentConfig | undefined, params: AgentInvocationParams) {
  return {
    modelInput: agentConfig?.model ?? params.model,
    modelFromParams: agentConfig?.model == null && params.model != null,
    thinking: agentConfig?.thinking ?? parseThinking(params.thinking),
    maxTurns: agentConfig?.maxTurns ?? params.max_turns,
    inheritContext: agentConfig?.inheritContext ?? params.inherit_context ?? false,
    runInBackground: agentConfig?.runInBackground ?? params.run_in_background ?? false,
    isolated: agentConfig?.isolated ?? params.isolated ?? false,
    isolation: agentConfig?.isolation ?? params.isolation,
  };
}

export function resolveJoinMode(defaultJoinMode: JoinMode, runInBackground: boolean) {
  return runInBackground ? defaultJoinMode : undefined;
}
