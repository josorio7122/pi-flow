/**
 * Types for the agent manager.
 */

import type { ThinkingLevel } from "@mariozechner/pi-agent-core";
import type { Api, Model } from "@mariozechner/pi-ai";
import type { AgentSession, ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import type { AgentRecord, IsolationMode, SubagentType } from "../types.js";
import type { ToolActivity } from "./runner-types.js";

export type OnAgentComplete = (record: AgentRecord) => void;
export type OnAgentStart = (record: AgentRecord) => void;

export const DEFAULT_MAX_CONCURRENT = 4;

export interface SpawnArgs {
  pi: ExtensionAPI;
  ctx: ExtensionContext;
  type: SubagentType;
  prompt: string;
  options: SpawnOptions;
}

export interface SpawnOptions {
  description: string;
  model?: Model<Api> | undefined;
  maxTurns?: number | undefined;
  isolated?: boolean | undefined;
  inheritContext?: boolean | undefined;
  thinkingLevel?: ThinkingLevel | undefined;
  isBackground?: boolean | undefined;
  isolation?: IsolationMode | undefined;
  onToolActivity?: ((activity: ToolActivity) => void) | undefined;
  onTextDelta?: ((delta: string, fullText: string) => void) | undefined;
  onSessionCreated?: ((session: AgentSession) => void) | undefined;
  onTurnEnd?: ((turnCount: number) => void) | undefined;
}
