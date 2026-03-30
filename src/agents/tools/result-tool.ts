/**
 * get_subagent_result tool — check status and retrieve background agent results.
 * Returns full result to LLM, renders compact summary on screen.
 */

import type { AgentSession, ExtensionAPI, Theme } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
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
    // biome-ignore lint/complexity/useMaxParams: pi renderResult callback signature is fixed
    renderResult: (result, _, theme) => renderResultCompact(result, theme),
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

function renderResultCompact(result: { content: { type: string; text?: string }[]; details?: unknown }, theme: Theme) {
  const text = result.content[0]?.type === "text" ? result.content[0].text : "";
  if (!text) return new Text("", 0, 0);

  const lines = text.split("\n");
  // Parse header: "Type: scout | Status: completed | Tool uses: 42 | 526.4k token | Duration: 1:52"
  const typeLine = lines.find((l) => l.startsWith("Type:"));
  const descLine = lines.find((l) => l.startsWith("Description:"));

  if (!typeLine) return new Text(theme.fg("dim", text.split("\n")[0] ?? ""), 0, 0);

  const statusMatch = typeLine.match(/Status:\s*(\w+)/);
  const status = statusMatch?.[1] ?? "unknown";
  const desc = descLine?.replace("Description: ", "") ?? "";

  const isError = status === "error" || status === "stopped" || status === "aborted";
  const icon = isError
    ? theme.fg("error", "✗")
    : status === "running"
      ? theme.fg("accent", "⠋")
      : theme.fg("success", "✓");

  const toolMatch = typeLine.match(/Tool uses:\s*(\d+)/);
  const durationMatch = typeLine.match(/Duration:\s*([\d:.]+\w*)/);
  const tokenMatch = typeLine.match(/\|\s*([\d.]+[kM]?\s*token)/);

  const parts: string[] = [];
  if (toolMatch?.[1]) parts.push(`${toolMatch[1]} tool uses`);
  if (tokenMatch?.[1]) parts.push(tokenMatch[1]);
  if (durationMatch?.[1]) parts.push(durationMatch[1]);

  const statsStr = parts.length > 0 ? theme.fg("dim", parts.join(" · ")) : "";
  const resultLineCount = lines.length - 4; // subtract header lines

  let line = `${icon} ${theme.fg("dim", desc)} ${status !== "running" ? theme.fg("dim", status) : ""}`;
  if (statsStr) line += `\n  ${statsStr}`;
  if (resultLineCount > 0 && status !== "running") {
    line += "\n  " + theme.fg("dim", `${resultLineCount} lines of output delivered to agent`);
  }

  return new Text(line, 0, 0);
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
