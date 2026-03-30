/**
 * Notification system — debounced delivery of agent completion notifications.
 *
 * Manages pending nudges so get_subagent_result can cancel a notification
 * before it fires. Also registers the message renderer for notification cards.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import { buildNotificationDetails, formatTaskNotification } from "../extension/helpers.js";
import type { AgentRecord, NotificationDetails } from "../types.js";
import type { AgentActivity } from "../ui/formatters.js";
import { formatMs, formatTokens, formatTurns } from "../ui/formatters.js";
import type { AgentWidget } from "../ui/widget.js";

const NUDGE_HOLD_MS = 200;

export function createNotificationSystem({
  pi,
  widget,
  agentActivity,
}: {
  pi: ExtensionAPI;
  widget: AgentWidget;
  agentActivity: Map<string, AgentActivity>;
}) {
  const pendingNudges = new Map<string, ReturnType<typeof setTimeout>>();

  function scheduleNudge(key: string, send: () => void) {
    cancelNudge(key);
    pendingNudges.set(
      key,
      setTimeout(() => {
        pendingNudges.delete(key);
        send();
      }, NUDGE_HOLD_MS),
    );
  }

  function cancelNudge(key: string) {
    const timer = pendingNudges.get(key);
    if (timer != null) {
      clearTimeout(timer);
      pendingNudges.delete(key);
    }
  }

  function emitIndividualNudge(record: AgentRecord) {
    if (record.resultConsumed) return;

    const notification = formatTaskNotification(record, 500);

    pi.sendMessage<NotificationDetails>(
      {
        customType: "subagent-notification",
        content: notification,
        display: false,
        details: buildNotificationDetails({ record, resultMaxLen: 500, activity: agentActivity.get(record.id) }),
      },
      { deliverAs: "followUp", triggerTurn: true },
    );
  }

  function sendIndividualNudge(record: AgentRecord) {
    agentActivity.delete(record.id);
    scheduleNudge(record.id, () => emitIndividualNudge(record));
    widget.update();
  }

  function disposeAll() {
    for (const timer of pendingNudges.values()) clearTimeout(timer);
    pendingNudges.clear();
  }

  return { scheduleNudge, cancelNudge, sendIndividualNudge, disposeAll };
}

export type NotificationSystem = ReturnType<typeof createNotificationSystem>;

export function registerMessageRenderer(pi: ExtensionAPI) {
  // biome-ignore lint/complexity/useMaxParams: pi registerMessageRenderer callback signature is fixed
  pi.registerMessageRenderer<NotificationDetails>("subagent-notification", (message, { expanded }, theme) => {
    const d = message.details;
    if (!d) return undefined;

    // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: renders all agent status variants with conditional formatting
    function renderOne(d: NotificationDetails) {
      const isError = d.status === "error" || d.status === "stopped" || d.status === "aborted";
      const icon = isError ? theme.fg("error", "✗") : theme.fg("success", "✓");
      const statusText = isError ? d.status : d.status === "steered" ? "completed (steered)" : "completed";

      let line = `${icon} ${theme.bold(d.description)} ${theme.fg("dim", statusText)}`;

      const parts: string[] = [];
      if (d.turnCount > 0) parts.push(formatTurns(d.turnCount, d.maxTurns));
      if (d.toolUses > 0) parts.push(`${d.toolUses} tool use${d.toolUses === 1 ? "" : "s"}`);
      if (d.totalTokens > 0) parts.push(formatTokens(d.totalTokens));
      if (d.durationMs > 0) parts.push(formatMs(d.durationMs));
      if (parts.length) {
        line += "\n  " + parts.map((p) => theme.fg("dim", p)).join(" " + theme.fg("dim", "·") + " ");
      }

      if (expanded) {
        const lines = d.resultPreview.split("\n").slice(0, 30);
        for (const l of lines) line += "\n" + theme.fg("dim", `  ${l}`);
      } else {
        const preview = d.resultPreview.split("\n")[0]?.slice(0, 80) ?? "";
        line += "\n  " + theme.fg("dim", `⎿  ${preview}`);
      }

      return line;
    }

    const all = [d, ...(d.others ?? [])];
    return new Text(all.map(renderOne).join("\n"), 0, 0);
  });
}
