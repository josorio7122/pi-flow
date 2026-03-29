/**
 * helpers.ts — Shared helpers for tool execution and agent tracking.
 */

import type { AgentSession } from "@mariozechner/pi-coding-agent";
import type { AgentRecord, NotificationDetails } from "../types.js";
import { type AgentActivity, type AgentDetails, formatTokens } from "../ui/formatters.js";

/** Tool execute return value for a text response. */
export function textResult(msg: string, details?: AgentDetails | undefined) {
  return { content: [{ type: "text" as const, text: msg }], details } as {
    content: { type: "text"; text: string }[];
    details: AgentDetails;
  };
}

/** Safe token formatting — wraps session.getSessionStats() in try-catch. */
export function safeFormatTokens(session: { getSessionStats(): { tokens: { total: number } } } | undefined) {
  if (!session) return "";
  try {
    return formatTokens(session.getSessionStats().tokens.total);
  } catch {
    return "";
  }
}

/**
 * Create an AgentActivity state and spawn callbacks for tracking tool usage.
 * Used by both foreground and background paths to avoid duplication.
 */
/** Mutates state in place — applies a tool activity event. */
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
    onTextDelta: (_delta: string, fullText: string) => {
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

/** Human-readable status label for agent completion. */
function getStatusLabel(status: string, error?: string) {
  switch (status) {
    case "error":
      return `Error: ${error ?? "unknown"}`;
    case "aborted":
      return "Aborted (max turns exceeded)";
    case "steered":
      return "Wrapped up (turn limit)";
    case "stopped":
      return "Stopped";
    default:
      return "Done";
  }
}

/** Parenthetical status note for completed agent result text. */
export function getStatusNote(status: string) {
  switch (status) {
    case "aborted":
      return " (aborted — max turns exceeded, output may be incomplete)";
    case "steered":
      return " (wrapped up — reached turn limit)";
    case "stopped":
      return " (stopped by user)";
    default:
      return "";
  }
}

/** Escape XML special characters to prevent injection in structured notifications. */
function escapeXml(s: string) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Format a structured task notification matching Claude Code's <task-notification> XML. */
/** Safely extract total token count from a session. */
function getTokenCount(session: { getSessionStats(): { tokens: { total: number } } } | undefined) {
  try {
    return session?.getSessionStats().tokens?.total ?? 0;
  } catch {
    return 0;
  }
}

export function formatTaskNotification(record: AgentRecord, resultMaxLen: number) {
  const status = getStatusLabel(record.status, record.error);
  const durationMs = record.completedAt ? record.completedAt - record.startedAt : 0;
  const totalTokens = getTokenCount(record.session);

  const resultPreview = record.result
    ? record.result.length > resultMaxLen
      ? record.result.slice(0, resultMaxLen) + "\n...(truncated, use get_subagent_result for full output)"
      : record.result
    : "No output.";

  return [
    `<task-notification>`,
    `<task-id>${record.id}</task-id>`,
    record.toolCallId ? `<tool-use-id>${escapeXml(record.toolCallId)}</tool-use-id>` : null,
    record.outputFile ? `<output-file>${escapeXml(record.outputFile)}</output-file>` : null,
    `<status>${escapeXml(status)}</status>`,
    `<summary>Agent "${escapeXml(record.description)}" ${record.status}</summary>`,
    `<result>${escapeXml(resultPreview)}</result>`,
    `<usage><total_tokens>${totalTokens}</total_tokens><tool_uses>${record.toolUses}</tool_uses><duration_ms>${durationMs}</duration_ms></usage>`,
    `</task-notification>`,
  ]
    .filter(Boolean)
    .join("\n");
}

/** Build AgentDetails from a base + record-specific fields. */
export function buildDetails({
  base,
  record,
  activity,
  overrides,
}: {
  base: {
    displayName: string;
    description: string;
    subagentType: string;
    modelName?: string | undefined;
    tags?: string[] | undefined;
  };
  record: {
    toolUses: number;
    startedAt: number;
    completedAt?: number | undefined;
    status: string;
    error?: string | undefined;
    id?: string | undefined;
    session?: { getSessionStats(): { tokens: { total: number } } } | undefined;
  };
  activity?: AgentActivity | undefined;
  overrides?: Partial<AgentDetails> | undefined;
}) {
  return {
    ...base,
    toolUses: record.toolUses,
    tokens: safeFormatTokens(record.session),
    turnCount: activity?.turnCount,
    maxTurns: activity?.maxTurns,
    durationMs: (record.completedAt ?? Date.now()) - record.startedAt,
    status: record.status as AgentDetails["status"],
    agentId: record.id,
    error: record.error,
    ...overrides,
  };
}

/** Build notification details for the custom message renderer. */
export function buildNotificationDetails({
  record,
  resultMaxLen,
  activity,
}: {
  record: AgentRecord;
  resultMaxLen: number;
  activity?: AgentActivity | undefined;
}): NotificationDetails {
  const totalTokens = getTokenCount(record.session);

  return {
    id: record.id,
    description: record.description,
    status: record.status,
    toolUses: record.toolUses,
    turnCount: activity?.turnCount ?? 0,
    maxTurns: activity?.maxTurns,
    totalTokens,
    durationMs: record.completedAt ? record.completedAt - record.startedAt : 0,
    outputFile: record.outputFile,
    error: record.error,
    resultPreview: record.result
      ? record.result.length > resultMaxLen
        ? record.result.slice(0, resultMaxLen) + "…"
        : record.result
      : "No output.",
  };
}
