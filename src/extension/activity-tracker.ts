/**
 * Activity tracker — tracks tool usage, turns, tokens for a running agent.
 * Used by both foreground and background spawn paths.
 */

import type { AgentSession } from "@mariozechner/pi-coding-agent";
import type { AgentActivity } from "../ui/formatters.js";
import { safeFormatTokens } from "./helpers.js";

function applyToolActivity(state: AgentActivity, activity: { type: "start" | "end"; toolName: string }) {
  if (activity.type === "start") {
    state.activeTools.set(activity.toolName + "_" + Date.now(), activity.toolName);
  } else {
    for (const [key, name] of state.activeTools) {
      if (name === activity.toolName) {
        state.activeTools.delete(key);
        break;
      }
    }
    state.toolUses++;
  }
}

export function createActivityTracker(maxTurns?: number, onStreamUpdate?: () => void) {
  const state: AgentActivity = {
    activeTools: new Map(),
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
