/**
 * Activity tracker — tracks tool usage, turns, tokens for a running agent.
 * Used by both foreground and background spawn paths.
 */

import type { AgentSession } from "@mariozechner/pi-coding-agent";
import type { AgentActivity } from "../ui/formatters.js";
import { safeFormatTokens } from "./helpers.js";

function formatToolArg(toolName: string, args?: Record<string, unknown>) {
  if (!args) return undefined;
  if (toolName === "read" || toolName === "edit" || toolName === "write") {
    const p = args.path;
    return typeof p === "string" ? shortenPath(p) : undefined;
  }
  if (toolName === "bash") {
    const cmd = args.command;
    return typeof cmd === "string" ? (cmd.length > 60 ? `${cmd.slice(0, 57)}…` : cmd) : undefined;
  }
  if (toolName === "grep") {
    const pattern = args.pattern;
    return typeof pattern === "string" ? `"${pattern}"` : undefined;
  }
  return undefined;
}

function shortenPath(p: string) {
  const parts = p.split("/");
  return parts.length > 2 ? parts.slice(-2).join("/") : p;
}

function applyToolActivity(
  state: AgentActivity,
  activity: { type: "start" | "end"; toolName: string; args?: Record<string, unknown> },
) {
  if (activity.type === "start") {
    const key = activity.toolName + "_" + Date.now();
    state.activeTools.set(key, activity.toolName);
    const arg = formatToolArg(activity.toolName, activity.args);
    if (arg) state.lastToolArgs.set(key, arg);
  } else {
    for (const [key, name] of state.activeTools) {
      if (name === activity.toolName) {
        state.activeTools.delete(key);
        state.lastToolArgs.delete(key);
        break;
      }
    }
    state.toolUses++;
  }
}

export function createActivityTracker(maxTurns?: number, onStreamUpdate?: () => void) {
  const state: AgentActivity = {
    activeTools: new Map(),
    lastToolArgs: new Map(),
    toolUses: 0,
    turnCount: 1,
    maxTurns,
    tokens: "",
    responseText: "",
    session: undefined,
  };

  const callbacks = {
    onToolActivity: (activity: { type: "start" | "end"; toolName: string }) => {
      applyToolActivity(state, activity);
      state.tokens = safeFormatTokens(state.session);
      onStreamUpdate?.();
    },
    onTextDelta: (_: string, fullText: string) => {
      state.responseText = fullText;
      onStreamUpdate?.();
    },
    onTurnEnd: (turnCount: number) => {
      state.turnCount = turnCount;
      onStreamUpdate?.();
    },
    onSessionCreated: (session: AgentSession) => {
      state.session = session;
    },
  };

  return { state, callbacks };
}
