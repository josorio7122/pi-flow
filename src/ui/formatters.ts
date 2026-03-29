/**
 * formatters.ts — Formatting helpers and shared types for agent UI.
 */

import type { Theme } from "@mariozechner/pi-coding-agent";
import { getConfig } from "../agents/registry.js";
import type { SubagentType } from "../types.js";

/** Braille spinner frames for animated running indicator. */
export const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

/** Statuses that indicate an error/non-success outcome. */
export const ERROR_STATUSES = new Set(["error", "aborted", "steered", "stopped"]);

/** Tool name → human-readable action for activity descriptions. */
const TOOL_DISPLAY: Record<string, string> = {
  read: "reading",
  bash: "running command",
  edit: "editing",
  write: "writing",
  grep: "searching",
  find: "finding files",
  ls: "listing",
};



/** Per-agent live activity state. */
export interface AgentActivity {
  activeTools: Map<string, string>;
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
  tags?: string[] | undefined;
  turnCount?: number | undefined;
  maxTurns?: number | undefined;
  agentId?: string | undefined;
  error?: string | undefined;
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

/** Get display name for any agent type (built-in or custom). */
export function getDisplayName(type: SubagentType) {
  const config = getConfig(type);
  return config?.displayName ?? type;
}

/** Get the prompt mode label for an agent type (undefined if "replace"). */
export function getPromptModeLabel(type: SubagentType) {
  const config = getConfig(type);
  if (!config) return undefined;
  return config.promptMode === "append" ? "append" : undefined;
}

/** Build a human-readable activity description from active tools and response text. */
export function describeActivity(activeTools: Map<string, string>, responseText?: string) {
  if (activeTools.size > 0) {
    const names = [...activeTools.values()];
    const unique = [...new Set(names)];
    const descriptions = unique.map(n => TOOL_DISPLAY[n] ?? n);
    return descriptions.join(", ");
  }
  if (responseText) {
    const trimmed = responseText.trim();
    if (trimmed.length > 0) {
      const lastLine = trimmed.split("\n").pop() ?? "";
      return lastLine.length > 80 ? `${lastLine.slice(0, 77)}…` : lastLine;
    }
  }
  return "thinking…";
}
