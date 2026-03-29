/**
 * Agent lifecycle — event emission, completion routing, group join delivery.
 * Extracted from index.ts to isolate the notification delivery pipeline.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import type { GroupJoinManager } from "../extension/group-join.js";
import { buildNotificationDetails, formatTaskNotification } from "../extension/helpers.js";
import type { AgentRecord, NotificationDetails } from "../types.js";
import type { AgentActivity } from "../ui/formatters.js";
import type { AgentWidget } from "../ui/widget.js";
import type { BatchSystem } from "./batch.js";
import type { NotificationSystem } from "./notification.js";

function buildEventData(record: AgentRecord) {
  const durationMs = record.completedAt ? record.completedAt - record.startedAt : Date.now() - record.startedAt;
  let tokens: { input: number; output: number; total: number } | undefined;
  try {
    if (record.session) {
      const stats = record.session.getSessionStats();
      tokens = { input: stats.tokens?.input ?? 0, output: stats.tokens?.output ?? 0, total: stats.tokens?.total ?? 0 };
    }
  } catch {
    /* session stats unavailable */
  }
  return {
    id: record.id,
    type: record.type,
    description: record.description,
    result: record.result,
    error: record.error,
    status: record.status,
    toolUses: record.toolUses,
    durationMs,
    tokens,
  };
}

export function createGroupJoinCallback({
  pi,
  agentActivity,
  getWidget,
  getNotifications,
}: {
  pi: ExtensionAPI;
  agentActivity: Map<string, AgentActivity>;
  getWidget: () => AgentWidget;
  getNotifications: () => NotificationSystem;
}) {
  return (records: AgentRecord[], partial: boolean) => {
    const w = getWidget();
    for (const r of records) {
      agentActivity.delete(r.id);
      w.markFinished(r.id);
    }

    const groupKey = `group:${records.map((r) => r.id).join(",")}`;
    getNotifications().scheduleNudge(groupKey, () => {
      const unconsumed = records.filter((r) => !r.resultConsumed);
      if (unconsumed.length === 0) {
        getWidget().update();
        return;
      }

      const notificationText = unconsumed.map((r) => formatTaskNotification(r, 300)).join("\n\n");
      const label = partial
        ? `${unconsumed.length} agent(s) finished (partial — others still running)`
        : `${unconsumed.length} agent(s) finished`;

      const [first, ...rest] = unconsumed;
      if (!first) return;
      const details = buildNotificationDetails({
        record: first,
        resultMaxLen: 300,
        activity: agentActivity.get(first.id),
      });
      if (rest.length > 0) {
        details.others = rest.map((r) =>
          buildNotificationDetails({ record: r, resultMaxLen: 300, activity: agentActivity.get(r.id) }),
        );
      }

      pi.sendMessage<NotificationDetails>(
        {
          customType: "subagent-notification",
          content: `Background agent group completed: ${label}\n\n${notificationText}\n\nUse get_subagent_result for full output.`,
          display: true,
          details,
        },
        { deliverAs: "followUp", triggerTurn: true },
      );
    });
    getWidget().update();
  };
}

export function createOnComplete({
  pi,
  agentActivity,
  getWidget,
  getBatch,
  groupJoin,
  getNotifications,
}: {
  pi: ExtensionAPI;
  agentActivity: Map<string, AgentActivity>;
  getWidget: () => AgentWidget;
  getBatch: () => BatchSystem;
  groupJoin: GroupJoinManager;
  getNotifications: () => NotificationSystem;
}) {
  return (record: AgentRecord) => {
    const widget = getWidget();
    const batch = getBatch();
    const isError = record.status === "error" || record.status === "stopped" || record.status === "aborted";
    const eventData = buildEventData(record);
    pi.events.emit(isError ? "subagents:failed" : "subagents:completed", eventData);

    pi.appendEntry("subagents:record", {
      id: record.id,
      type: record.type,
      description: record.description,
      status: record.status,
      result: record.result,
      error: record.error,
      startedAt: record.startedAt,
      completedAt: record.completedAt,
    });

    if (record.resultConsumed) {
      agentActivity.delete(record.id);
      widget.markFinished(record.id);
      widget.update();
      return;
    }

    if (batch.isInBatch(record.id)) {
      widget.update();
      return;
    }

    const result = groupJoin.onAgentComplete(record);
    if (result === "pass") getNotifications().sendIndividualNudge(record);
    widget.update();
  };
}
