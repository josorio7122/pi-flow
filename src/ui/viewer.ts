/**
 * viewer.ts — Live conversation overlay for viewing agent sessions.
 *
 * Displays a scrollable, live-updating view of an agent's conversation.
 * Subscribes to session events for real-time streaming updates.
 */

import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { AgentSession, Theme, ThemeColor } from "@mariozechner/pi-coding-agent";
import {
  type Component,
  matchesKey,
  type TUI,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
} from "@mariozechner/pi-tui";
import type { Registry } from "../agents/registry.js";
import { extractText } from "../infra/context.js";
import type { AgentRecord } from "../types.js";
import {
  type AgentActivity,
  describeActivity,
  formatDuration,
  formatTokens,
  getDisplayName,
  getPromptModeLabel,
} from "./formatters.js";

/** Lines consumed by chrome: top border + header + header sep + footer sep + footer + bottom border. */
const CHROME_LINES = 6;
const MIN_VIEWPORT = 3;

export class ConversationViewer implements Component {
  private scrollOffset = 0;
  private autoScroll = true;
  private unsubscribe: (() => void) | undefined;
  private lastInnerW = 0;
  private closed = false;

  constructor(
    private tui: TUI,
    private session: AgentSession,
    private record: AgentRecord,
    private activity: AgentActivity | undefined,
    private theme: Theme,
    private done: (result: undefined) => void,
    private registry: Registry,
  ) {
    this.unsubscribe = session.subscribe(() => {
      if (this.closed) return;
      this.tui.requestRender();
    });
  }

  handleInput(data: string) {
    if (matchesKey(data, "escape") || matchesKey(data, "q")) {
      this.closed = true;
      this.done(undefined);
      return;
    }

    const totalLines = this.buildContentLines(this.lastInnerW).length;
    const viewportHeight = this.viewportHeight();
    const maxScroll = Math.max(0, totalLines - viewportHeight);

    if (matchesKey(data, "up") || matchesKey(data, "k")) {
      this.scrollOffset = Math.max(0, this.scrollOffset - 1);
      this.autoScroll = this.scrollOffset >= maxScroll;
    } else if (matchesKey(data, "down") || matchesKey(data, "j")) {
      this.scrollOffset = Math.min(maxScroll, this.scrollOffset + 1);
      this.autoScroll = this.scrollOffset >= maxScroll;
    } else if (matchesKey(data, "pageUp")) {
      this.scrollOffset = Math.max(0, this.scrollOffset - viewportHeight);
      this.autoScroll = false;
    } else if (matchesKey(data, "pageDown")) {
      this.scrollOffset = Math.min(maxScroll, this.scrollOffset + viewportHeight);
      this.autoScroll = this.scrollOffset >= maxScroll;
    } else if (matchesKey(data, "home")) {
      this.scrollOffset = 0;
      this.autoScroll = false;
    } else if (matchesKey(data, "end")) {
      this.scrollOffset = maxScroll;
      this.autoScroll = true;
    }
  }

  render(width: number) {
    if (width < 6) return []; // too narrow for any meaningful rendering
    const th = this.theme;
    const innerW = width - 4; // border + padding
    this.lastInnerW = innerW;
    const lines: string[] = [];

    const pad = (s: string, len: number) => {
      const vis = visibleWidth(s);
      return s + " ".repeat(Math.max(0, len - vis));
    };
    const row = (content: string) =>
      th.fg("border", "│") + " " + truncateToWidth(pad(content, innerW), innerW) + " " + th.fg("border", "│");
    const hrTop = th.fg("border", `╭${"─".repeat(width - 2)}╮`);
    const hrBot = th.fg("border", `╰${"─".repeat(width - 2)}╯`);
    const hrMid = row(th.fg("dim", "─".repeat(innerW)));

    // Header
    lines.push(hrTop);
    const cfg = this.registry.getConfig(this.record.type);
    const name = getDisplayName(this.record.type, cfg.displayName);
    const modeLabel = getPromptModeLabel(cfg.promptMode);
    const modeTag = modeLabel ? ` ${th.fg("dim", `(${modeLabel})`)}` : "";
    const statusIcons: Record<string, [ThemeColor, string]> = {
      running: ["accent", "●"],
      completed: ["success", "✓"],
      steered: ["warning", "✓"],
      error: ["error", "✗"],
      aborted: ["error", "✗"],
      stopped: ["dim", "■"],
    };
    const [iconColor, iconChar] = statusIcons[this.record.status] ?? ["dim", "○"];
    const statusIcon = th.fg(iconColor, iconChar);
    const duration = formatDuration(this.record.startedAt, this.record.completedAt);

    const headerParts: string[] = [duration];
    const toolUses = this.activity?.toolUses ?? this.record.toolUses;
    if (toolUses > 0) headerParts.unshift(`${toolUses} tool${toolUses === 1 ? "" : "s"}`);
    if (this.activity?.session) {
      try {
        const tokens = this.activity.session.getSessionStats().tokens.total;
        if (tokens > 0) headerParts.push(formatTokens(tokens));
      } catch {
        /* */
      }
    }

    lines.push(
      row(
        `${statusIcon} ${th.bold(name)}${modeTag}  ${th.fg("muted", this.record.description)} ${th.fg("dim", "·")} ${th.fg("dim", headerParts.join(" · "))}`,
      ),
    );
    lines.push(hrMid);

    // Content area — rebuild every render (live data, no cache needed)
    const contentLines = this.buildContentLines(innerW);
    const viewportHeight = this.viewportHeight();
    const maxScroll = Math.max(0, contentLines.length - viewportHeight);

    if (this.autoScroll) {
      this.scrollOffset = maxScroll;
    }

    const visibleStart = Math.min(this.scrollOffset, maxScroll);
    const visible = contentLines.slice(visibleStart, visibleStart + viewportHeight);

    for (let i = 0; i < viewportHeight; i++) {
      lines.push(row(visible[i] ?? ""));
    }

    // Footer
    lines.push(hrMid);
    const scrollPct =
      contentLines.length <= viewportHeight
        ? "100%"
        : `${Math.round(((visibleStart + viewportHeight) / contentLines.length) * 100)}%`;
    const footerLeft = th.fg("dim", `${contentLines.length} lines · ${scrollPct}`);
    const footerRight = th.fg("dim", "↑↓ scroll · PgUp/PgDn · Esc close");
    const footerGap = Math.max(1, innerW - visibleWidth(footerLeft) - visibleWidth(footerRight));
    lines.push(row(footerLeft + " ".repeat(footerGap) + footerRight));
    lines.push(hrBot);

    return lines;
  }

  invalidate() {
    /* no cached state to clear */
  }

  dispose() {
    this.closed = true;
    if (this.unsubscribe) {
      this.unsubscribe();
      this.unsubscribe = undefined;
    }
  }

  // ---- Private ----

  private viewportHeight() {
    return Math.max(MIN_VIEWPORT, this.tui.terminal.rows - CHROME_LINES);
  }

  private buildContentLines(width: number) {
    return buildConversationLines({
      messages: this.session.messages,
      activity: this.activity,
      status: this.record.status,
      width,
      theme: this.theme,
    });
  }
}

/** Pure — builds conversation content lines from messages and activity state. */
function buildConversationLines({
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
    const rendered = renderMessage(msg, th, width);
    if (!rendered) continue;
    if (needsSeparator) lines.push(th.fg("dim", "───"));
    lines.push(...rendered);
    needsSeparator = true;
  }

  // Streaming indicator for running agents
  if (status === "running" && activity) {
    const act = describeActivity(activity.activeTools, activity.responseText);
    lines.push("");
    lines.push(truncateToWidth(th.fg("accent", "▍ ") + th.fg("dim", act), width));
  }

  return lines.map((l) => truncateToWidth(l, width));
}

/** Render a single message to lines, or undefined to skip. */
function renderMessage(msg: AgentMessage, th: Theme, width: number) {
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
