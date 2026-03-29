/**
 * Pure content builder for the conversation viewer.
 * Renders agent messages into displayable lines.
 */

import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { Theme } from "@mariozechner/pi-coding-agent";
import { truncateToWidth, wrapTextWithAnsi } from "@mariozechner/pi-tui";
import { extractText } from "../infra/context.js";
import { type AgentActivity, describeActivity } from "./formatters.js";

export function buildConversationLines({
  messages,
  activity,
  status,
  width,
  theme,
}: {
  messages: readonly AgentMessage[];
  activity: AgentActivity | undefined;
  status: string;
  width: number;
  theme: Theme;
}) {
  if (width <= 0) return [];

  const th = theme;
  const lines: string[] = [];

  if (messages.length === 0) {
    lines.push(th.fg("dim", "(waiting for first message...)"));
    return lines;
  }

  let needsSeparator = false;
  for (const msg of messages) {
    const rendered = renderMessage({ msg, th, width });
    if (!rendered) continue;
    if (needsSeparator) lines.push(th.fg("dim", "───"));
    lines.push(...rendered);
    needsSeparator = true;
  }

  if (status === "running" && activity) {
    const act = describeActivity(activity.activeTools, activity.responseText);
    lines.push("");
    lines.push(truncateToWidth(th.fg("accent", "▍ ") + th.fg("dim", act), width));
  }

  return lines.map((l) => truncateToWidth(l, width));
}

function renderMessage({ msg, th, width }: { msg: AgentMessage; th: Theme; width: number }) {
  switch (msg.role) {
    case "user": {
      const text = typeof msg.content === "string" ? msg.content : extractText(msg.content);
      if (!text.trim()) return undefined;
      return [th.fg("accent", "[User]"), ...wrapTextWithAnsi(text.trim(), width)];
    }
    case "assistant": {
      const textParts = msg.content.filter((c) => c.type === "text" && c.text).map((c) => (c as { text: string }).text);
      const toolCalls = msg.content
        .filter((c) => c.type === "toolCall")
        .map((c) => (c as { name: string }).name ?? "unknown");
      const lines: string[] = [th.bold("[Assistant]")];
      if (textParts.length > 0) lines.push(...wrapTextWithAnsi(textParts.join("\n").trim(), width));
      for (const name of toolCalls) lines.push(truncateToWidth(th.fg("muted", `  [Tool: ${name}]`), width));
      return lines;
    }
    case "toolResult": {
      const text = extractText(msg.content);
      const truncated = text.length > 500 ? text.slice(0, 500) + "... (truncated)" : text;
      if (!truncated.trim()) return undefined;
      return [th.fg("dim", "[Result]"), ...wrapTextWithAnsi(truncated.trim(), width).map((l) => th.fg("dim", l))];
    }
    default: {
      const raw = msg as { role: string; command?: string; output?: string };
      if (raw.role !== "bashExecution") return undefined;
      const lines = [truncateToWidth(th.fg("muted", `  $ ${raw.command}`), width)];
      if (raw.output?.trim()) {
        const out = raw.output.length > 500 ? raw.output.slice(0, 500) + "... (truncated)" : raw.output;
        lines.push(...wrapTextWithAnsi(out.trim(), width).map((l) => th.fg("dim", l)));
      }
      return lines;
    }
  }
}
