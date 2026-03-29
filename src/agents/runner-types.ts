/**
 * Runner types, settings, and shared helpers.
 */

import type { ThinkingLevel } from "@mariozechner/pi-agent-core";
import type { Api, Model } from "@mariozechner/pi-ai";
import type { AgentSession, ExtensionAPI } from "@mariozechner/pi-coding-agent";
import type { Registry } from "./registry.js";

export interface ToolActivity {
  type: "start" | "end";
  toolName: string;
}

export interface RunnerSettings {
  defaultMaxTurns: number | undefined;
  graceTurns: number;
}

export function normalizeMaxTurns(n: number | undefined) {
  if (n == null || n === 0) return undefined;
  return Math.max(1, Math.round(n));
}

export function createRunnerSettings(): RunnerSettings {
  return { defaultMaxTurns: undefined, graceTurns: 5 };
}

export interface RunOptions {
  pi: ExtensionAPI;
  description?: string | undefined;
  model?: Model<Api> | undefined;
  maxTurns?: number | undefined;
  signal?: AbortSignal | undefined;
  isolated?: boolean | undefined;
  inheritContext?: boolean | undefined;
  thinkingLevel?: ThinkingLevel | undefined;
  cwd?: string | undefined;
  onToolActivity?: ((activity: ToolActivity) => void) | undefined;
  onTextDelta?: ((delta: string, fullText: string) => void) | undefined;
  onSessionCreated?: ((session: AgentSession) => void) | undefined;
  onTurnEnd?: ((turnCount: number) => void) | undefined;
  settings?: RunnerSettings | undefined;
  registry?: Registry | undefined;
}
