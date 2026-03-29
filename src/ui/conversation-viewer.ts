/**
 * conversation-viewer.ts — Scrollable conversation overlay for agent sessions.
 *
 * Displays a live-updating view of an agent's messages, tool calls, and results.
 * Subscribes to session events for real-time streaming.
 */

import type { BackgroundRecord } from '../background.js';
import { extractText } from '../context.js';
import type { AgentActivity, Theme } from './agent-widget.js';
import { describeActivity, formatDuration } from './agent-widget.js';

// ─── Types ────────────────────────────────────────────────────────────────────

interface TUI {
  terminal: { columns: number; rows: number };
  requestRender(): void;
}

interface Component {
  handleInput(data: string): void;
  render(width: number): string[];
  invalidate(): void;
  dispose(): void;
}

// ─── Constants ────────────────────────────────────────────────────────────────

const CHROME_LINES = 6;
const MIN_VIEWPORT = 3;

// ─── Helper ───────────────────────────────────────────────────────────────────

function truncate(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  return text.slice(0, maxLen) + '…';
}

function wrapText(text: string, width: number): string[] {
  if (width <= 0) return [];
  const lines: string[] = [];
  for (const line of text.split('\n')) {
    if (line.length <= width) {
      lines.push(line);
    } else {
      for (let i = 0; i < line.length; i += width) {
        lines.push(line.slice(i, i + width));
      }
    }
  }
  return lines;
}

// ─── ConversationViewer ───────────────────────────────────────────────────────

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
    if (data === '\x1b' || data === 'q') {
      this.closed = true;
      this.done(undefined);
      return;
    }

    const totalLines = this.buildContentLines(this.lastInnerW).length;
    const viewportHeight = this.viewportHeight();
    const maxScroll = Math.max(0, totalLines - viewportHeight);

    if (data === '\x1b[A' || data === 'k') {
      this.scrollOffset = Math.max(0, this.scrollOffset - 1);
      this.autoScroll = this.scrollOffset >= maxScroll;
    } else if (data === '\x1b[B' || data === 'j') {
      this.scrollOffset = Math.min(maxScroll, this.scrollOffset + 1);
      this.autoScroll = this.scrollOffset >= maxScroll;
    } else if (data === '\x1b[5~') {
      this.scrollOffset = Math.max(0, this.scrollOffset - viewportHeight);
      this.autoScroll = false;
    } else if (data === '\x1b[6~') {
      this.scrollOffset = Math.min(maxScroll, this.scrollOffset + viewportHeight);
      this.autoScroll = this.scrollOffset >= maxScroll;
    }
  }

  render(width: number): string[] {
    if (width < 6) return [];
    const th = this.theme;
    const innerW = width - 4;
    this.lastInnerW = innerW;
    const lines: string[] = [];

    const row = (content: string) =>
      th.fg('border' as string, '│') +
      ' ' +
      truncate(content, innerW) +
      ' '.repeat(Math.max(0, innerW - content.length)) +
      ' ' +
      th.fg('border' as string, '│');

    const hrTop = th.fg('border' as string, `╭${'─'.repeat(width - 2)}╮`);
    const hrBot = th.fg('border' as string, `╰${'─'.repeat(width - 2)}╯`);
    const hrMid = row(th.fg('dim', '─'.repeat(innerW)));

    // Header
    lines.push(hrTop);
    const statusIcon =
      this.record.status === 'running'
        ? th.fg('accent', '●')
        : this.record.status === 'completed'
          ? th.fg('success', '✓')
          : th.fg('error', '✗');
    const duration = formatDuration(this.record.startedAt, this.record.completedAt);
    lines.push(
      row(
        `${statusIcon} ${th.bold(this.record.agent.name)}  ${th.fg('muted', this.record.description)} ${th.fg('dim', '·')} ${th.fg('dim', duration)}`,
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
    lines.push(
      row(
        `${th.fg('dim', `${contentLines.length} lines · ${scrollPct}`)}  ${th.fg('dim', '↑↓ scroll · Esc close')}`,
      ),
    );
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

    for (const msg of messages) {
      if (msg.role === 'user') {
        const text =
          typeof msg.content === 'string' ? msg.content : extractText(msg.content as unknown[]);
        if (!text.trim()) continue;
        lines.push(th.fg('accent', '[User]'));
        for (const line of wrapText(text.trim(), width)) lines.push(line);
        lines.push('');
      } else if (msg.role === 'assistant') {
        const textParts: string[] = [];
        const toolCalls: string[] = [];
        for (const c of msg.content as Array<Record<string, unknown>>) {
          if (c.type === 'text' && c.text) textParts.push(c.text as string);
          else if (c.type === 'toolCall') toolCalls.push((c.name as string) ?? 'unknown');
        }
        lines.push(th.bold('[Assistant]'));
        if (textParts.length > 0) {
          for (const line of wrapText(textParts.join('\n').trim(), width)) lines.push(line);
        }
        for (const name of toolCalls) {
          lines.push(th.fg('muted', `  [Tool: ${name}]`));
        }
        lines.push('');
      } else if (msg.role === 'toolResult') {
        const text = extractText(msg.content as unknown[]);
        const trunc = text.length > 500 ? text.slice(0, 500) + '... (truncated)' : text;
        if (!trunc.trim()) continue;
        lines.push(th.fg('dim', '[Result]'));
        for (const line of wrapText(trunc.trim(), width)) lines.push(th.fg('dim', line));
        lines.push('');
      }
    }

    // Streaming indicator
    if (this.record.status === 'running' && this.activity) {
      const act = describeActivity(this.activity.activeTools, this.activity.responseText);
      lines.push(th.fg('accent', '▍ ') + th.fg('dim', act));
    }

    return lines;
  }
}
