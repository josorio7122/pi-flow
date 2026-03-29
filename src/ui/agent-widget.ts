/**
 * agent-widget.ts — Persistent widget showing running/completed agents above the editor.
 *
 * Displays running agents with animated spinners, live stats, and activity descriptions.
 * Uses the callback form of setWidget for themed rendering.
 */

import { truncateToWidth } from '@mariozechner/pi-tui';
import type { BackgroundManager, BackgroundRecord } from '../background.js';

// ─── Constants ────────────────────────────────────────────────────────────────

const MAX_WIDGET_LINES = 12;

export const SPINNER = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

const ERROR_STATUSES = new Set(['error', 'aborted']);

const TOOL_DISPLAY: Record<string, string> = {
  read: 'reading',
  bash: 'running command',
  edit: 'editing',
  write: 'writing',
  grep: 'searching',
  find: 'finding files',
  ls: 'listing',
};

// ─── Types ────────────────────────────────────────────────────────────────────

export interface Theme {
  fg(color: string, text: string): string;
  bold(text: string): string;
}

export interface UICtx {
  setStatus(key: string, text: string | undefined): void;
  setWidget(
    key: string,
    content:
      | undefined
      | ((
          tui: { terminal: { columns: number; rows: number }; requestRender(): void },
          theme: Theme,
        ) => { render(): string[]; invalidate(): void }),
    options?: { placement?: 'aboveEditor' | 'belowEditor' },
  ): void;
}

export interface AgentActivity {
  activeTools: Map<string, string>;
  toolUses: number;
  responseText: string;
  turnCount: number;
  maxTurns?: number;
}

// ─── Formatting helpers ───────────────────────────────────────────────────────

export function formatTokens(count: number): string {
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
  if (count >= 1_000) return `${(count / 1_000).toFixed(1)}k`;
  return `${count}`;
}

export function formatTurns(turnCount: number, maxTurns?: number | null): string {
  return maxTurns != null ? `⟳${turnCount}≤${maxTurns}` : `⟳${turnCount}`;
}

export function formatMs(ms: number): string {
  return `${(ms / 1000).toFixed(1)}s`;
}

export function formatDuration(startedAt: number, completedAt?: number): string {
  if (completedAt) return formatMs(completedAt - startedAt);
  return `${formatMs(Date.now() - startedAt)} (running)`;
}

export function describeActivity(activeTools: Map<string, string>, responseText?: string): string {
  if (activeTools.size > 0) {
    const groups = new Map<string, number>();
    for (const toolName of activeTools.values()) {
      const action = TOOL_DISPLAY[toolName] ?? toolName;
      groups.set(action, (groups.get(action) ?? 0) + 1);
    }
    const parts: string[] = [];
    for (const [action, count] of groups) {
      parts.push(count > 1 ? `${action} ${count} files` : action);
    }
    return parts.join(', ') + '…';
  }
  if (responseText?.trim()) {
    const line =
      responseText
        .split('\n')
        .find((l) => l.trim())
        ?.trim() ?? '';
    return line.length > 60 ? line.slice(0, 60) + '…' : line;
  }
  return 'thinking…';
}

// ─── Widget ───────────────────────────────────────────────────────────────────

export class FlowAgentWidget {
  private uiCtx: UICtx | undefined;
  private widgetFrame = 0;
  private widgetInterval: ReturnType<typeof setInterval> | undefined;
  private finishedTurnAge = new Map<string, number>();
  private widgetRegistered = false;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- TUI reference
  private tui: any;
  private lastStatusText: string | undefined;

  constructor(
    private manager: BackgroundManager,
    private activityMap: Map<string, AgentActivity>,
  ) {}

  setUICtx(ctx: UICtx): void {
    if (ctx !== this.uiCtx) {
      this.uiCtx = ctx;
      this.widgetRegistered = false;
      this.tui = undefined;
      this.lastStatusText = undefined;
    }
  }

  onTurnStart(): void {
    for (const [id, age] of this.finishedTurnAge) {
      this.finishedTurnAge.set(id, age + 1);
    }
    this.update();
  }

  ensureTimer(): void {
    if (!this.widgetInterval) {
      this.widgetInterval = setInterval(() => this.update(), 80);
    }
  }

  markFinished(agentId: string): void {
    if (!this.finishedTurnAge.has(agentId)) {
      this.finishedTurnAge.set(agentId, 0);
    }
  }

  private shouldShowFinished(agentId: string, status: string): boolean {
    const age = this.finishedTurnAge.get(agentId) ?? 0;
    const maxAge = ERROR_STATUSES.has(status) ? 2 : 1;
    return age < maxAge;
  }

  update(): void {
    if (!this.uiCtx) return;
    const allAgents = this.manager.listAgents();

    let runningCount = 0;
    let queuedCount = 0;
    let hasFinished = false;
    for (const a of allAgents) {
      if (a.status === 'running') runningCount++;
      else if (a.status === 'queued') queuedCount++;
      else if (a.completedAt && this.shouldShowFinished(a.id, a.status)) hasFinished = true;
    }
    const hasActive = runningCount > 0 || queuedCount > 0;

    if (!hasActive && !hasFinished) {
      if (this.widgetRegistered) {
        this.uiCtx.setWidget('flow-agents', undefined);
        this.widgetRegistered = false;
        this.tui = undefined;
      }
      if (this.lastStatusText !== undefined) {
        this.uiCtx.setStatus('pi-flow-agents', undefined);
        this.lastStatusText = undefined;
      }
      if (this.widgetInterval) {
        clearInterval(this.widgetInterval);
        this.widgetInterval = undefined;
      }
      return;
    }

    // Status bar
    let newStatusText: string | undefined;
    if (hasActive) {
      const parts: string[] = [];
      if (runningCount > 0) parts.push(`${runningCount} running`);
      if (queuedCount > 0) parts.push(`${queuedCount} queued`);
      const total = runningCount + queuedCount;
      newStatusText = `${parts.join(', ')} agent${total === 1 ? '' : 's'}`;
    }
    if (newStatusText !== this.lastStatusText) {
      this.uiCtx.setStatus('pi-flow-agents', newStatusText);
      this.lastStatusText = newStatusText;
    }

    this.widgetFrame++;

    if (!this.widgetRegistered) {
      this.uiCtx.setWidget(
        'flow-agents',
        (tui, theme) => {
          this.tui = tui;
          return {
            render: () => this.renderWidget(tui, theme, allAgents),
            invalidate: () => {
              this.widgetRegistered = false;
              this.tui = undefined;
            },
          };
        },
        { placement: 'aboveEditor' },
      );
      this.widgetRegistered = true;
    } else {
      this.tui?.requestRender();
    }
  }

  private renderWidget(
    tui: { terminal: { columns: number } },
    theme: Theme,
    _allAgents: BackgroundRecord[],
  ): string[] {
    const w = tui.terminal.columns;
    const truncate = (line: string) => truncateToWidth(line, w);
    const allAgents = this.manager.listAgents();
    const running = allAgents.filter((a) => a.status === 'running');
    const queued = allAgents.filter((a) => a.status === 'queued');
    const finished = allAgents.filter(
      (a) =>
        a.status !== 'running' &&
        a.status !== 'queued' &&
        a.completedAt &&
        this.shouldShowFinished(a.id, a.status),
    );

    if (running.length === 0 && queued.length === 0 && finished.length === 0) return [];

    const hasActive = running.length > 0 || queued.length > 0;
    const headingColor = hasActive ? 'accent' : 'dim';
    const headingIcon = hasActive ? '●' : '○';
    const frame = SPINNER[this.widgetFrame % SPINNER.length];

    const lines: string[] = [
      theme.fg(headingColor, headingIcon) + ' ' + theme.fg(headingColor, 'Agents'),
    ];

    let budget = MAX_WIDGET_LINES - 1;

    // Running agents (2 lines each)
    for (const a of running) {
      if (budget < 2) break;
      const elapsed = formatMs(Date.now() - a.startedAt);
      const activity = this.activityMap.get(a.id);
      const parts: string[] = [];
      if (activity) parts.push(formatTurns(activity.turnCount, activity.maxTurns));
      if (a.toolUses) parts.push(`${a.toolUses} tools`);
      parts.push(elapsed);

      lines.push(
        truncate(
          theme.fg('dim', '├─') +
            ` ${theme.fg('accent', frame)} ${theme.bold(a.agent.name)}  ${theme.fg('muted', a.description)} ${theme.fg('dim', '·')} ${theme.fg('dim', parts.join(' · '))}`,
        ),
      );
      const act = activity
        ? describeActivity(activity.activeTools, activity.responseText)
        : 'thinking…';
      lines.push(truncate(theme.fg('dim', '│  ') + theme.fg('dim', `  ⎿  ${act}`)));
      budget -= 2;
    }

    // Queued
    if (queued.length > 0 && budget >= 1) {
      lines.push(
        truncate(
          theme.fg('dim', '├─') +
            ` ${theme.fg('muted', '◦')} ${theme.fg('dim', `${queued.length} queued`)}`,
        ),
      );
      budget--;
    }

    // Finished
    for (const a of finished) {
      if (budget < 1) break;
      const icon =
        a.status === 'completed'
          ? theme.fg('success', '✓')
          : a.status === 'error' || a.status === 'aborted'
            ? theme.fg('error', '✗')
            : theme.fg('dim', '■');
      const dur = formatMs((a.completedAt ?? Date.now()) - a.startedAt);
      lines.push(
        truncate(
          theme.fg('dim', '├─') +
            ` ${icon} ${theme.fg('dim', a.agent.name)}  ${theme.fg('dim', a.description)} ${theme.fg('dim', '·')} ${theme.fg('dim', dur)}`,
        ),
      );
      budget--;
    }

    // Fix last connector
    if (lines.length > 1) {
      lines[lines.length - 1] = lines[lines.length - 1].replace('├─', '└─');
    }

    return lines;
  }

  dispose(): void {
    if (this.widgetInterval) {
      clearInterval(this.widgetInterval);
      this.widgetInterval = undefined;
    }
    if (this.uiCtx) {
      this.uiCtx.setWidget('flow-agents', undefined);
      this.uiCtx.setStatus('pi-flow-agents', undefined);
    }
    this.widgetRegistered = false;
    this.tui = undefined;
    this.lastStatusText = undefined;
  }
}
