/**
 * get_subagent_result tool — check status and retrieve background agent results.
 */

import type { AgentSession, ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { safeFormatTokens, textResult } from "../../extension/helpers.js";
import { extractText } from "../../infra/context.js";
import { formatDuration, getDisplayName } from "../../ui/formatters.js";
import type { AgentManager } from "../manager.js";
import type { NotificationSystem } from "../notification.js";
import type { Registry } from "../registry.js";

export function registerResultTool({
  pi,
  manager,
  registry,
  notifications,
}: {
  pi: ExtensionAPI;
  manager: AgentManager;
  registry: Registry;
  notifications: NotificationSystem;
}) {
  pi.registerTool({
    name: "get_subagent_result",
    label: "Get Agent Result",
    description:
      "Check status and retrieve results from a background agent. Use the agent ID returned by Agent with run_in_background.",
    parameters: Type.Object({
      agent_id: Type.String({ description: "The agent ID to check." }),
      wait: Type.Optional(Type.Boolean({ description: "If true, wait for the agent to complete. Default: false." })),
      verbose: Type.Optional(Type.Boolean({ description: "If true, include full conversation. Default: false." })),
    }),
    execute: async (_, params) => {
      const record = manager.getRecord(params.agent_id);
      if (!record) {
        return textResult(`Agent not found: "${params.agent_id}". It may have been cleaned up.`);
      }

      if (params.wait && record.status === "running" && record.promise) {
        record.resultConsumed = true;
        notifications.cancelNudge(params.agent_id);
        await record.promise;
      }

      const recConfig = registry.getAgentConfig(record.type);
      const displayName = getDisplayName(record.type, recConfig?.displayName);
      const duration = formatDuration(record.startedAt, record.completedAt);
      const tokens = safeFormatTokens(record.session);
      const toolStats = tokens ? `Tool uses: ${record.toolUses} | ${tokens}` : `Tool uses: ${record.toolUses}`;

      let output =
        `Agent: ${record.id}\n` +
        `Type: ${displayName} | Status: ${record.status} | ${toolStats} | Duration: ${duration}\n` +
        `Description: ${record.description}\n\n`;

      if (record.status === "running") {
        output += "Agent is still running. Use wait: true or check back later.";
      } else if (record.status === "error") {
        output += `Error: ${record.error}`;
      } else {
        output += record.result?.trim() || "No output.";
      }

      if (record.status !== "running" && record.status !== "queued") {
        record.resultConsumed = true;
        notifications.cancelNudge(params.agent_id);
      }

      if (params.verbose && record.session) {
        const conversation = formatConversation(record.session);
        if (conversation) {
          output += `\n\n--- Agent Conversation ---\n${conversation}`;
        }
      }

      return textResult(output);
    },
  });
}

function formatConversation(session: AgentSession) {
  return session.messages
    .map((msg) => {
      if (msg.role === "user") {
        const text = typeof msg.content === "string" ? msg.content : extractText(msg.content);
        return `[User]\n${text}`;
      }
      if (msg.role === "assistant") {
        const text = msg.content
          .filter((c) => c.type === "text")
          .map((c) => (c as { text: string }).text)
          .join("\n");
        const tools = msg.content.filter((c) => c.type === "toolCall").map((c) => (c as { name: string }).name);
        return `[Assistant]\n${text}${tools.length ? `\n[Tools: ${tools.join(", ")}]` : ""}`;
      }
      if (msg.role === "toolResult") {
        const text = extractText(msg.content);
        return `[Tool Result]\n${text.slice(0, 200)}${text.length > 200 ? "..." : ""}`;
      }
      return null;
    })
    .filter(Boolean)
    .join("\n\n");
}
