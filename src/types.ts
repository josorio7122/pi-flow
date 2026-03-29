/**
 * types.ts — Type definitions for the subagent system.
 */

import type { ThinkingLevel } from "@mariozechner/pi-agent-core";
import type { AgentSession } from "@mariozechner/pi-coding-agent";

export type { ThinkingLevel };

/** Agent type: any string name (built-in defaults or user-defined). */
export type SubagentType = string;

/** Names of the three embedded default agents. */
export const DEFAULT_AGENT_NAMES = ["general-purpose", "Explore", "Plan"] as const;

/** Memory scope for persistent agent memory. */
export type MemoryScope = "user" | "project" | "local";

/** Isolation mode for agent execution. */
export type IsolationMode = "worktree";

/** Unified agent configuration — used for both default and user-defined agents. */
export interface AgentConfig {
  name: string;
  displayName?: string | undefined;
  description: string;
  builtinToolNames?: string[] | undefined;
  /** Tool denylist — these tools are removed even if `builtinToolNames` or extensions include them. */
  disallowedTools?: string[] | undefined;
  /** true = inherit all, string[] = only listed, false = none */
  extensions: true | string[] | false;
  /** true = inherit all, string[] = only listed, false = none */
  skills: true | string[] | false;
  model?: string | undefined;
  thinking?: ThinkingLevel | undefined;
  maxTurns?: number | undefined;
  systemPrompt: string;
  promptMode: "replace" | "append";
  /** Default for spawn: fork parent conversation. undefined = caller decides. */
  inheritContext?: boolean | undefined;
  /** Default for spawn: run in background. undefined = caller decides. */
  runInBackground?: boolean | undefined;
  /** Default for spawn: no extension tools. undefined = caller decides. */
  isolated?: boolean | undefined;
  /** Persistent memory scope — agents with memory get a persistent directory and MEMORY.md */
  memory?: MemoryScope | undefined;
  /** Isolation mode — "worktree" runs the agent in a temporary git worktree */
  isolation?: IsolationMode | undefined;
  /** true = this is an embedded default agent (informational) */
  isDefault?: boolean | undefined;
  /** false = agent is hidden from the registry */
  enabled?: boolean | undefined;
  /** Where this agent was loaded from */
  source?: "default" | "project" | "global" | undefined;
}

export type JoinMode = 'async' | 'group' | 'smart';

export interface AgentRecord {
  id: string;
  type: SubagentType;
  description: string;
  status: "queued" | "running" | "completed" | "steered" | "aborted" | "stopped" | "error";
  result?: string | undefined;
  error?: string | undefined;
  toolUses: number;
  startedAt: number;
  completedAt?: number | undefined;
  session?: AgentSession | undefined;
  abortController?: AbortController | undefined;
  promise?: Promise<string> | undefined;
  groupId?: string | undefined;
  joinMode?: JoinMode | undefined;
  /** Set when result was already consumed via get_subagent_result — suppresses completion notification. */
  resultConsumed?: boolean | undefined;
  /** Steering messages queued before the session was ready. */
  pendingSteers?: string[] | undefined;
  /** Worktree info if the agent is running in an isolated worktree. */
  worktree?: { path: string; branch: string } | undefined;
  /** Worktree cleanup result after agent completion. */
  worktreeResult?: { hasChanges: boolean; branch?: string | undefined } | undefined;
  /** The tool_use_id from the original Agent tool call. */
  toolCallId?: string | undefined;
  /** Path to the streaming output transcript file. */
  outputFile?: string | undefined;
  /** Cleanup function for the output file stream subscription. */
  outputCleanup?: (() => void) | undefined;
}

/** Details attached to custom notification messages for visual rendering. */
export interface NotificationDetails {
  id: string;
  description: string;
  status: string;
  toolUses: number;
  turnCount: number;
  maxTurns?: number | undefined;
  totalTokens: number;
  durationMs: number;
  outputFile?: string | undefined;
  error?: string | undefined;
  resultPreview: string;
  /** Additional agents in a group notification. */
  others?: NotificationDetails[] | undefined;
}

export interface EnvInfo {
  isGitRepo: boolean;
  branch: string;
  platform: string;
}
