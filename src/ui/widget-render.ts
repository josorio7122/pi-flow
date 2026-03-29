/**
 * Pure render helpers for the agent widget.
 * Build display lines from agent data — no side effects, no this.
 */

import type { Theme, ThemeColor } from "@mariozechner/pi-coding-agent";
import { truncateToWidth } from "@mariozechner/pi-tui";
import type { AgentRecord, SubagentType } from "../types.js";
import {
  type AgentActivity,
  describeActivity,
  formatMs,
  formatTokens,
  formatTurns,
  getDisplayName,
  getPromptModeLabel,
} from "./formatters.js";

const MAX_WIDGET_LINES = 12;

const STATUS_DISPLAY: Record<string, { color: ThemeColor; char: string; label: string }> = {
  completed: { color: "success", char: "✓", label: "" },
  steered: { color: "warning", char: "✓", label: " (turn limit)" },
  stopped: { color: "dim", char: "■", label: " stopped" },
  error: { color: "error", char: "✗", label: " error" },
  aborted: { color: "error", char: "✗", label: " aborted" },
};

export function renderFinishedLine({
  agent,
  theme,
  activity,
  config,
}: {
  agent: {
    id: string;
    type: SubagentType;
    status: string;
    description: string;
    toolUses: number;
    startedAt: number;
    completedAt?: number | undefined;
    error?: string | undefined;
  };
  theme: Theme;
  activity?: AgentActivity | undefined;
  config?: { displayName: string; promptMode: "replace" | "append" } | undefined;
}) {
  const cfg = config ?? { displayName: agent.type, promptMode: "replace" as const };
  const name = getDisplayName(agent.type, cfg.displayName);
  const modeLabel = getPromptModeLabel(cfg.promptMode);
  const duration = formatMs((agent.completedAt ?? Date.now()) - agent.startedAt);

  const display = STATUS_DISPLAY[agent.status] ?? STATUS_DISPLAY.aborted!;
  const icon = theme.fg(display.color, display.char);
  const statusSuffix =
    agent.status === "error" && agent.error
      ? theme.fg(display.color, `${display.label}: ${agent.error.slice(0, 60)}`)
      : display.label
        ? theme.fg(display.color, display.label)
        : "";

  const parts = [
    ...(activity ? [formatTurns(activity.turnCount, activity.maxTurns)] : []),
    ...(agent.toolUses > 0 ? [`${agent.toolUses} tool use${agent.toolUses === 1 ? "" : "s"}`] : []),
    duration,
  ];

  const modeTag = modeLabel ? ` ${theme.fg("dim", `(${modeLabel})`)}` : "";
  return `${icon} ${theme.fg("dim", name)}${modeTag}  ${theme.fg("dim", agent.description)} ${theme.fg("dim", "·")} ${theme.fg("dim", parts.join(" · "))}${statusSuffix}`;
}

export function renderRunningLine({
  agent,
  theme,
  activity,
  config,
  frame,
}: {
  agent: AgentRecord;
  theme: Theme;
  activity?: AgentActivity | undefined;
  config: { displayName: string; promptMode: "replace" | "append" };
  frame: string;
}) {
  const name = getDisplayName(agent.type, config.displayName);
  const modeLabel = getPromptModeLabel(config.promptMode);
  const modeTag = modeLabel ? ` ${theme.fg("dim", `(${modeLabel})`)}` : "";
  const elapsed = formatMs(Date.now() - agent.startedAt);

  const toolUses = activity?.toolUses ?? agent.toolUses;
  let tokenText = "";
  if (activity?.session) {
    try {
      tokenText = formatTokens(activity.session.getSessionStats().tokens.total);
    } catch {
      /* */
    }
  }

  const parts: string[] = [];
  if (activity) parts.push(formatTurns(activity.turnCount, activity.maxTurns));
  if (toolUses > 0) parts.push(`${toolUses} tool use${toolUses === 1 ? "" : "s"}`);
  if (tokenText) parts.push(tokenText);
  parts.push(elapsed);

  const activityText = activity ? describeActivity(activity.activeTools, activity.responseText) : "thinking…";

  return {
    header: `${theme.fg("dim", "├─")} ${theme.fg("accent", frame)} ${theme.bold(name)}${modeTag}  ${theme.fg("muted", agent.description)} ${theme.fg("dim", "·")} ${theme.fg("dim", parts.join(" · "))}`,
    activity: `${theme.fg("dim", "│  ")}${theme.fg("dim", `  ⎿  ${activityText}`)}`,
  };
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: layout logic with overflow budget allocation
export function assembleWidgetLines({
  heading,
  finishedLines,
  runningPairs,
  queuedLine,
  width,
  theme,
}: {
  heading: string;
  finishedLines: readonly string[];
  runningPairs: readonly { header: string; activity: string }[];
  queuedLine: string | undefined;
  width: number;
  theme: Theme;
}) {
  const truncate = (line: string) => truncateToWidth(line, width);
  const maxBody = MAX_WIDGET_LINES - 1;
  const totalBody = finishedLines.length + runningPairs.length * 2 + (queuedLine ? 1 : 0);
  const lines: string[] = [truncate(heading)];

  if (totalBody <= maxBody) {
    lines.push(...finishedLines.map(truncate));
    for (const pair of runningPairs) {
      lines.push(truncate(pair.header));
      lines.push(truncate(pair.activity));
    }
    if (queuedLine) lines.push(truncate(queuedLine));

    if (lines.length > 1) {
      const last = lines.length - 1;
      lines[last] = lines[last]!.replace("├─", "└─");
      if (runningPairs.length > 0 && !queuedLine && last >= 2) {
        lines[last - 1] = lines[last - 1]!.replace("├─", "└─");
        lines[last] = lines[last]!.replace("│  ", "   ");
      }
    }
  } else {
    let budget = maxBody - 1;
    let hiddenRunning = 0;
    let hiddenFinished = 0;

    for (const pair of runningPairs) {
      if (budget >= 2) {
        lines.push(truncate(pair.header));
        lines.push(truncate(pair.activity));
        budget -= 2;
      } else {
        hiddenRunning++;
      }
    }
    if (queuedLine && budget >= 1) {
      lines.push(truncate(queuedLine));
      budget--;
    }
    for (const fl of finishedLines) {
      if (budget >= 1) {
        lines.push(truncate(fl));
        budget--;
      } else {
        hiddenFinished++;
      }
    }

    const overflowParts: string[] = [];
    if (hiddenRunning > 0) overflowParts.push(`${hiddenRunning} running`);
    if (hiddenFinished > 0) overflowParts.push(`${hiddenFinished} finished`);
    lines.push(
      truncate(
        `${theme.fg("dim", "└─")} ${theme.fg("dim", `+${hiddenRunning + hiddenFinished} more (${overflowParts.join(", ")})`)}`,
      ),
    );
  }

  return lines;
}
