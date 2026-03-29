/**
 * agent-widget.ts — Persistent widget showing running/completed agents above the editor.
 *
 * Displays a tree of agents with animated spinners, live stats, and activity descriptions.
 * Uses the callback form of setWidget for themed rendering.
 * Full parity with tintinweb/pi-subagents' AgentWidget.
 */

import { truncateToWidth } from '@mariozechner/pi-tui';
import type { BackgroundManager, BackgroundRecord } from '../background.js';

// ─── Constants ────────────────────────────────────────────────────────────────

const MAX_WIDGET_LINES = 12;

export const SPINNER = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

export const ERROR_STATUSES = new Set(['error', 'aborted', 'steered', 'stopped']);

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
          // eslint-disable-next-line @typescript-eslint/no-explicit-any -- TUI interface varies
          tui: any,
          theme: Theme,
        ) => { render(): string[]; invalidate(): void }),
    options?: { placement?: 'aboveEditor' | 'belowEditor' },
  ): void;
}

export interface AgentActivity {
  activeTools: Map<string, string>;
  toolUses: number;
  tokens: string;
  responseText: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- session stats interface
  session?: { getSessionStats(): { tokens: { total: number } } };
  turnCount: number;
  maxTurns?: number;
}

/** Metadata attached to dispatch_flow tool results for custom rendering. */
export interface AgentDetails {
  displayName: string;
  description: string;
  agentType: string;
  toolUses: number;
  tokens: string;
  durationMs: number;
  status:
    | 'queued'
    | 'running'
    | 'completed'
    | 'steered'
    | 'aborted'
    | 'stopped'
    | 'error'
    | 'background';
  activity?: string;
  spinnerFrame?: number;
  modelName?: string;
  tags?: string[];
  turnCount?: number;
  maxTurns?: number;
  agentId?: string;
  error?: string;
}

// ─── Formatting helpers ───────────────────────────────────────────────────────

export function formatTokens(count: number): string {
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1)}M token`;
  if (count >= 1_000) return `${(count / 1_000).toFixed(1)}k token`;
  return `${count} token`;
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

/** Safe token formatting — wraps session.getSessionStats() in try-catch. */
export function safeFormatTokens(
  session: { getSessionStats(): { tokens: { total: number } } } | undefined,
): string {
  if (!session) return '';
  try {
    return formatTokens(session.getSessionStats().tokens.total);
  } catch {
    return '';
  }
}

/** Get the display name for an agent. Uses label if available, falls back to name. */
export function getDisplayName(agent: { label?: string; name: string }): string {
  return agent.label || agent.name;
}

/** Short label for prompt mode: "twin" for append, nothing for replace. */
export function getPromptModeLabel(agent: { promptMode?: string }): string | undefined {
  return agent.promptMode === 'append' ? 'twin' : undefined;
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
      if (count > 1) {
        parts.push(`${action} ${count} ${action === 'searching' ? 'patterns' : 'files'}`);
      } else {
        parts.push(action);
      }
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
  private static readonly ERROR_LINGER_TURNS = 2;
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
    const maxAge = ERROR_STATUSES.has(status) ? FlowAgentWidget.ERROR_LINGER_TURNS : 1;
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
      // Clean up stale entries
      for (const [id] of this.finishedTurnAge) {
        if (!allAgents.some((a) => a.id === id)) this.finishedTurnAge.delete(id);
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
            render: () => this.renderWidget(tui, theme),
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

  private renderFinishedLine(a: BackgroundRecord, theme: Theme): string {
    const name = getDisplayName(a.agent);
    const modeLabel = getPromptModeLabel(a.agent);
    const modeTag = modeLabel ? ` ${theme.fg('dim', `(${modeLabel})`)}` : '';
    const duration = formatMs((a.completedAt ?? Date.now()) - a.startedAt);

    let icon: string;
    let statusText = '';
    if (a.status === 'completed') {
      icon = theme.fg('success', '✓');
    } else if (a.status === 'steered') {
      icon = theme.fg('warning', '✓');
      statusText = theme.fg('warning', ' (turn limit)');
    } else if (a.status === 'error') {
      icon = theme.fg('error', '✗');
      const errMsg = a.error ? `: ${a.error.slice(0, 60)}` : '';
      statusText = theme.fg('error', ` error${errMsg}`);
    } else if (a.status === 'aborted') {
      icon = theme.fg('error', '✗');
      statusText = theme.fg('warning', ' aborted');
    } else {
      icon = theme.fg('dim', '■');
      statusText = theme.fg('dim', ` ${a.status}`);
    }

    const parts: string[] = [];
    const activity = this.activityMap.get(a.id);
    if (activity) parts.push(formatTurns(activity.turnCount, activity.maxTurns));
    if ((a.toolUses ?? 0) > 0) parts.push(`${a.toolUses} tool use${a.toolUses === 1 ? '' : 's'}`);
    parts.push(duration);

    return `${icon} ${theme.fg('dim', name)}${modeTag}  ${theme.fg('dim', a.description)} ${theme.fg('dim', '·')} ${theme.fg('dim', parts.join(' · '))}${statusText}`;
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- TUI interface
  private renderWidget(tui: any, theme: Theme): string[] {
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

    const hasActive = running.length > 0 || queued.length > 0;
    const hasFinished = finished.length > 0;
    if (!hasActive && !hasFinished) return [];

    const w = tui.terminal.columns;
    const truncate = (line: string) => truncateToWidth(line, w);
    const headingColor = hasActive ? 'accent' : 'dim';
    const headingIcon = hasActive ? '●' : '○';
    const frame = SPINNER[this.widgetFrame % SPINNER.length];

    // Build sections separately for overflow-aware assembly
    const finishedLines: string[] = [];
    for (const a of finished) {
      finishedLines.push(truncate(theme.fg('dim', '├─') + ' ' + this.renderFinishedLine(a, theme)));
    }

    const runningLines: string[][] = []; // [header, activity] pairs
    for (const a of running) {
      const name = getDisplayName(a.agent);
      const modeLabel = getPromptModeLabel(a.agent);
      const modeTag = modeLabel ? ` ${theme.fg('dim', `(${modeLabel})`)}` : '';
      const elapsed = formatMs(Date.now() - a.startedAt);

      const bg = this.activityMap.get(a.id);
      const toolUses = bg?.toolUses ?? a.toolUses ?? 0;
      let tokenText = '';
      if (bg?.session) {
        tokenText = safeFormatTokens(bg.session);
      }

      const parts: string[] = [];
      if (bg) parts.push(formatTurns(bg.turnCount, bg.maxTurns));
      if (toolUses > 0) parts.push(`${toolUses} tool use${toolUses === 1 ? '' : 's'}`);
      if (tokenText) parts.push(tokenText);
      parts.push(elapsed);

      const act = bg ? describeActivity(bg.activeTools, bg.responseText) : 'thinking…';

      runningLines.push([
        truncate(
          theme.fg('dim', '├─') +
            ` ${theme.fg('accent', frame)} ${theme.bold(name)}${modeTag}  ${theme.fg('muted', a.description)} ${theme.fg('dim', '·')} ${theme.fg('dim', parts.join(' · '))}`,
        ),
        truncate(theme.fg('dim', '│  ') + theme.fg('dim', `  ⎿  ${act}`)),
      ]);
    }

    const queuedLine =
      queued.length > 0
        ? truncate(
            theme.fg('dim', '├─') +
              ` ${theme.fg('muted', '◦')} ${theme.fg('dim', `${queued.length} queued`)}`,
          )
        : undefined;

    // Assemble with overflow cap
    const maxBody = MAX_WIDGET_LINES - 1;
    const totalBody = finishedLines.length + runningLines.length * 2 + (queuedLine ? 1 : 0);

    const lines: string[] = [
      truncate(theme.fg(headingColor, headingIcon) + ' ' + theme.fg(headingColor, 'Agents')),
    ];

    if (totalBody <= maxBody) {
      // Everything fits
      lines.push(...finishedLines);
      for (const pair of runningLines) lines.push(...pair);
      if (queuedLine) lines.push(queuedLine);

      // Fix last connector
      if (lines.length > 1) {
        const last = lines.length - 1;
        lines[last] = lines[last].replace('├─', '└─');
        // If last item is a running agent activity line, fix its indent
        if (runningLines.length > 0 && !queuedLine) {
          if (last >= 2) {
            lines[last - 1] = lines[last - 1].replace('├─', '└─');
            lines[last] = lines[last].replace('│  ', '   ');
          }
        }
      }
    } else {
      // Overflow — prioritize: running > queued > finished
      let budget = maxBody - 1; // reserve 1 for overflow indicator
      let hiddenRunning = 0;
      let hiddenFinished = 0;

      for (const pair of runningLines) {
        if (budget >= 2) {
          lines.push(...pair);
          budget -= 2;
        } else {
          hiddenRunning++;
        }
      }
      if (queuedLine && budget >= 1) {
        lines.push(queuedLine);
        budget--;
      }
      for (const fl of finishedLines) {
        if (budget >= 1) {
          lines.push(fl);
          budget--;
        } else {
          hiddenFinished++;
        }
      }

      const overflowParts: string[] = [];
      if (hiddenRunning > 0) overflowParts.push(`${hiddenRunning} running`);
      if (hiddenFinished > 0) overflowParts.push(`${hiddenFinished} finished`);
      const overflowText = overflowParts.join(', ');
      lines.push(
        truncate(
          theme.fg('dim', '└─') +
            ` ${theme.fg('dim', `+${hiddenRunning + hiddenFinished} more (${overflowText})`)}`,
        ),
      );
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
