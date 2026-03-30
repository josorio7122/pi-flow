/**
 * formatters.ts — Formatting helpers and shared types for agent UI.
 */

import type { SubagentType } from "../types.js";

/** Braille spinner frames for animated running indicator. */
export const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

/** Tool name → human-readable action label. */
const TOOL_LABELS: Record<string, string> = {
  read: "reading",
  bash: "running",
  edit: "editing",
  write: "writing",
  grep: "searching",
  find: "finding",
  ls: "listing",
};

/** Per-agent live activity state. */
export interface AgentActivity {
  activeTools: Map<string, string>;
  /** Last tool args for display (e.g. file path, command). */
  lastToolArgs: Map<string, string>;
  toolUses: number;
  tokens: string;
  responseText: string;
  session?: { getSessionStats(): { tokens: { total: number } } } | undefined;
  turnCount: number;
  maxTurns?: number | undefined;
}

/** Metadata attached to Agent tool results for custom rendering. */
export interface AgentDetails {
  displayName: string;
  description: string;
  subagentType: string;
  toolUses: number;
  tokens: string;
  durationMs: number;
  status: "queued" | "running" | "completed" | "steered" | "aborted" | "stopped" | "error" | "background";
  activity?: string | undefined;
  spinnerFrame?: number | undefined;
  modelName?: string | undefined;
  tags?: readonly string[] | undefined;
  turnCount?: number | undefined;
  maxTurns?: number | undefined;
  agentId?: string | undefined;
  error?: string | undefined;
  /** Full streaming response text for live preview. */
  responseText?: string | undefined;
}

/** Format a token count compactly: "33.8k token", "1.2M token". */
export function formatTokens(count: number) {
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1)}M token`;
  if (count >= 1_000) return `${(count / 1_000).toFixed(1)}k token`;
  return `${count} token`;
}

/** Format turn count with optional max limit: "⟳5≤30" or "⟳5". */
export function formatTurns(turnCount: number, maxTurns?: number | null) {
  return maxTurns ? `⟳${turnCount}≤${maxTurns}` : `⟳${turnCount}`;
}

/** Format elapsed time compactly: "3.2s", "1:23". */
export function formatMs(ms: number) {
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60_000)}:${String(Math.floor((ms % 60_000) / 1000)).padStart(2, "0")}`;
}

/** Format duration from start to completion (or now). */
export function formatDuration(startedAt: number, completedAt?: number) {
  return formatMs((completedAt ?? Date.now()) - startedAt);
}

/** Get display name — uses displayName if provided, otherwise falls back to type. */
export function getDisplayName(type: SubagentType, displayName?: string) {
  return displayName ?? type;
}

/** Get the prompt mode label ("append" or undefined for "replace"). */
export function getPromptModeLabel(promptMode?: "replace" | "append") {
  return promptMode === "append" ? "append" : undefined;
}

/** Extract the first non-empty, non-heading line from agent output. */
export function firstMeaningfulLine(text: string, maxLen = 80) {
  for (const raw of text.split("\n")) {
    const trimmed = raw.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    return trimmed.length > maxLen ? `${trimmed.slice(0, maxLen - 1)}…` : trimmed;
  }
  return undefined;
}

/** Build a human-readable activity description from active tools. */
/** Build a human-readable activity description from active tools + args. */
export function describeActivity(activeTools: Map<string, string>, toolArgs?: Map<string, string>) {
  if (activeTools.size > 0) {
    const descriptions: string[] = [];
    for (const [key, name] of activeTools) {
      const label = TOOL_LABELS[name] ?? name;
      const arg = toolArgs?.get(key);
      descriptions.push(arg ? `${label} ${arg}` : label);
    }
    return [...new Set(descriptions)].join(", ");
  }
  return "thinking…";
}
