/**
 * conversation-viewer.ts — Scrollable conversation overlay for agent sessions.
 *
 * Displays a live-updating view of an agent's messages, tool calls, and results.
 * Subscribes to session events for real-time streaming.
 * Uses pi-tui primitives for proper ANSI-aware rendering.
 * Full parity with tintinweb/pi-subagents' ConversationViewer.
 */

import {
  type Component,
  matchesKey,
  type TUI,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
} from '@mariozechner/pi-tui';
import type { BackgroundRecord } from '../background.js';
import { extractText } from '../context.js';
import type { AgentActivity, Theme } from './agent-widget.js';
import {
  describeActivity,
  formatDuration,
  formatTokens,
  formatTurns,
  getDisplayName,
  getPromptModeLabel,
} from './agent-widget.js';

// ─── Constants ────────────────────────────────────────────────────────────────

const CHROME_LINES = 6;
const MIN_VIEWPORT = 3;

// ─── FlowConversationViewer ───────────────────────────────────────────────────

export class FlowConversationViewer implements Component {
  private scrollOffset = 0;
  private autoScroll = true;
  private unsubscribe: (() => void) | undefined;
  private lastInnerW = 0;
  private closed = false;

  constructor(
    private tui: TUI,
    private session: {
      messages: Array<{ role: string; content: unknown }>;
      subscribe(fn: (event: { type: string }) => void): () => void;
    },
    private record: BackgroundRecord,
    private activity: AgentActivity | undefined,
    private theme: Theme,
    private done: (result: undefined) => void,
  ) {
    this.unsubscribe = session.subscribe(() => {
      if (this.closed) return;
      this.tui.requestRender();
    });
  }

  handleInput(data: string): void {
    if (matchesKey(data, 'escape') || matchesKey(data, 'q')) {
      this.closed = true;
      this.done(undefined);
      return;
    }

    const totalLines = this.buildContentLines(this.lastInnerW).length;
    const viewportHeight = this.viewportHeight();
    const maxScroll = Math.max(0, totalLines - viewportHeight);

    if (matchesKey(data, 'up') || matchesKey(data, 'k')) {
      this.scrollOffset = Math.max(0, this.scrollOffset - 1);
      this.autoScroll = this.scrollOffset >= maxScroll;
    } else if (matchesKey(data, 'down') || matchesKey(data, 'j')) {
      this.scrollOffset = Math.min(maxScroll, this.scrollOffset + 1);
      this.autoScroll = this.scrollOffset >= maxScroll;
    } else if (matchesKey(data, 'pageUp')) {
      this.scrollOffset = Math.max(0, this.scrollOffset - viewportHeight);
      this.autoScroll = false;
    } else if (matchesKey(data, 'pageDown')) {
      this.scrollOffset = Math.min(maxScroll, this.scrollOffset + viewportHeight);
      this.autoScroll = this.scrollOffset >= maxScroll;
    } else if (matchesKey(data, 'home')) {
      this.scrollOffset = 0;
      this.autoScroll = false;
    } else if (matchesKey(data, 'end')) {
      this.scrollOffset = maxScroll;
      this.autoScroll = true;
    }
  }

  render(width: number): string[] {
    if (width < 6) return [];
    const th = this.theme;
    const innerW = width - 4;
    this.lastInnerW = innerW;
    const lines: string[] = [];

    const pad = (s: string, len: number) => {
      const vis = visibleWidth(s);
      return s + ' '.repeat(Math.max(0, len - vis));
    };
    const row = (content: string) =>
      th.fg('border', '│') +
      ' ' +
      truncateToWidth(pad(content, innerW), innerW) +
      ' ' +
      th.fg('border', '│');
    const hrTop = th.fg('border', `╭${'─'.repeat(width - 2)}╮`);
    const hrBot = th.fg('border', `╰${'─'.repeat(width - 2)}╯`);
    const hrMid = row(th.fg('dim', '─'.repeat(innerW)));

    // Header
    lines.push(hrTop);
    const name = getDisplayName(this.record.agent);
    const modeLabel = getPromptModeLabel(this.record.agent);
    const modeTag = modeLabel ? ` ${th.fg('dim', `(${modeLabel})`)}` : '';
    const statusIcon =
      this.record.status === 'running'
        ? th.fg('accent', '●')
        : this.record.status === 'completed'
          ? th.fg('success', '✓')
          : this.record.status === 'steered'
            ? th.fg('warning', '✓')
            : this.record.status === 'error'
              ? th.fg('error', '✗')
              : th.fg('dim', '○');
    const duration = formatDuration(this.record.startedAt, this.record.completedAt);

    const headerParts: string[] = [duration];
    const toolUses = this.activity?.toolUses ?? this.record.toolUses ?? 0;
    if (toolUses > 0) headerParts.unshift(`${toolUses} tool${toolUses === 1 ? '' : 's'}`);
    if (this.activity?.session) {
      try {
        const tokens = this.activity.session.getSessionStats().tokens.total;
        if (tokens > 0) headerParts.push(formatTokens(tokens));
      } catch {
        /* session stats unavailable */
      }
    }
    if (this.activity) {
      headerParts.unshift(formatTurns(this.activity.turnCount, this.activity.maxTurns));
    }

    lines.push(
      row(
        `${statusIcon} ${th.bold(name)}${modeTag}  ${th.fg('muted', this.record.description)} ${th.fg('dim', '·')} ${th.fg('dim', headerParts.join(' · '))}`,
      ),
    );
    lines.push(hrMid);

    // Content
    const contentLines = this.buildContentLines(innerW);
    const viewportHeight = this.viewportHeight();
    const maxScroll = Math.max(0, contentLines.length - viewportHeight);
    if (this.autoScroll) this.scrollOffset = maxScroll;

    const visibleStart = Math.min(this.scrollOffset, maxScroll);
    const visible = contentLines.slice(visibleStart, visibleStart + viewportHeight);
    for (let i = 0; i < viewportHeight; i++) {
      lines.push(row(visible[i] ?? ''));
    }

    // Footer
    lines.push(hrMid);
    const scrollPct =
      contentLines.length <= viewportHeight
        ? '100%'
        : `${Math.round(((visibleStart + viewportHeight) / contentLines.length) * 100)}%`;
    const footerLeft = th.fg('dim', `${contentLines.length} lines · ${scrollPct}`);
    const footerRight = th.fg('dim', '↑↓ scroll · PgUp/PgDn · Esc close');
    const footerGap = Math.max(1, innerW - visibleWidth(footerLeft) - visibleWidth(footerRight));
    lines.push(row(footerLeft + ' '.repeat(footerGap) + footerRight));
    lines.push(hrBot);

    return lines;
  }

  invalidate(): void {}

  dispose(): void {
    this.closed = true;
    if (this.unsubscribe) {
      this.unsubscribe();
      this.unsubscribe = undefined;
    }
  }

  private viewportHeight(): number {
    return Math.max(MIN_VIEWPORT, this.tui.terminal.rows - CHROME_LINES);
  }

  private buildContentLines(width: number): string[] {
    if (width <= 0) return [];
    const th = this.theme;
    const messages = this.session.messages;
    const lines: string[] = [];

    if (messages.length === 0) {
      lines.push(th.fg('dim', '(waiting for first message...)'));
      return lines;
    }

    let needsSeparator = false;
    for (const msg of messages) {
      if (msg.role === 'user') {
        const text =
          typeof msg.content === 'string' ? msg.content : extractText(msg.content as unknown[]);
        if (!text.trim()) continue;
        if (needsSeparator) lines.push(th.fg('dim', '───'));
        lines.push(th.fg('accent', '[User]'));
        for (const line of wrapTextWithAnsi(text.trim(), width)) lines.push(line);
      } else if (msg.role === 'assistant') {
        const textParts: string[] = [];
        const toolCalls: string[] = [];
        for (const c of msg.content as Array<Record<string, unknown>>) {
          if (c.type === 'text' && c.text) textParts.push(c.text as string);
          else if (c.type === 'toolCall')
            toolCalls.push((c.name as string) ?? (c.toolName as string) ?? 'unknown');
        }
        if (needsSeparator) lines.push(th.fg('dim', '───'));
        lines.push(th.bold('[Assistant]'));
        if (textParts.length > 0) {
          for (const line of wrapTextWithAnsi(textParts.join('\n').trim(), width)) lines.push(line);
        }
        for (const name of toolCalls) {
          lines.push(truncateToWidth(th.fg('muted', `  [Tool: ${name}]`), width));
        }
      } else if (msg.role === 'toolResult') {
        const text = extractText(msg.content as unknown[]);
        const truncated = text.length > 500 ? text.slice(0, 500) + '... (truncated)' : text;
        if (!truncated.trim()) continue;
        if (needsSeparator) lines.push(th.fg('dim', '───'));
        lines.push(th.fg('dim', '[Result]'));
        for (const line of wrapTextWithAnsi(truncated.trim(), width)) {
          lines.push(th.fg('dim', line));
        }
      } else if ((msg as Record<string, unknown>).role === 'bashExecution') {
        const bash = msg as Record<string, unknown>;
        if (needsSeparator) lines.push(th.fg('dim', '───'));
        lines.push(truncateToWidth(th.fg('muted', `  $ ${(bash.command as string) ?? ''}`), width));
        const output = (bash.output as string) ?? '';
        if (output.trim()) {
          const trunc = output.length > 500 ? output.slice(0, 500) + '... (truncated)' : output;
          for (const line of wrapTextWithAnsi(trunc.trim(), width)) {
            lines.push(th.fg('dim', line));
          }
        }
      } else {
        continue;
      }
      needsSeparator = true;
    }

    // Streaming indicator for running agents
    if (this.record.status === 'running' && this.activity) {
      const act = describeActivity(this.activity.activeTools, this.activity.responseText);
      lines.push('');
      lines.push(truncateToWidth(th.fg('accent', '▍ ') + th.fg('dim', act), width));
    }

    return lines.map((l) => truncateToWidth(l, width));
  }
}
