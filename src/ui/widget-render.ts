/**
 * Pure render helpers for the agent widget.
 * Build display lines from agent data — no side effects, no this.
 */

import type { Theme } from "@mariozechner/pi-coding-agent";
import { truncateToWidth } from "@mariozechner/pi-tui";
import type { AgentRecord } from "../types.js";
import {
  type AgentActivity,
  describeActivity,
  formatMs,
  formatTokens,
  formatTurns,
  getDisplayName,
} from "./formatters.js";

const MAX_WIDGET_LINES = 12;

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
  config: { displayName: string };
  frame: string;
}) {
  const name = getDisplayName(agent.type, config.displayName);
  const bgTag = agent.isBackground ? ` ${theme.fg("dim", "bg")}` : "";
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

  const activityText = activity ? describeActivity(activity.activeTools) : "thinking…";

  return {
    header: `${theme.fg("dim", "├─")} ${theme.fg("accent", frame)} ${theme.bold(name)}${bgTag}  ${theme.fg("muted", agent.description)} ${theme.fg("dim", "·")} ${theme.fg("dim", parts.join(" · "))}`,
    activity: `${theme.fg("dim", "│  ")}${theme.fg("dim", `  ⎿  ${activityText}`)}`,
  };
}

export function assembleWidgetLines({
  heading,
  runningPairs,
  queuedLine,
  width,
  theme,
}: {
  heading: string;
  runningPairs: readonly { header: string; activity: string }[];
  queuedLine: string | undefined;
  width: number;
  theme: Theme;
}) {
  const truncate = (line: string) => truncateToWidth(line, width);
  const maxBody = MAX_WIDGET_LINES - 1;
  const totalBody = runningPairs.length * 2 + (queuedLine ? 1 : 0);
  const lines: string[] = [truncate(heading)];

  if (totalBody <= maxBody) {
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
    }

    if (hiddenRunning > 0) {
      lines.push(truncate(`${theme.fg("dim", "└─")} ${theme.fg("dim", `+${hiddenRunning} more running`)}`));
    }
  }

  return lines;
}
