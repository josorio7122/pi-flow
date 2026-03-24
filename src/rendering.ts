import * as os from 'node:os';
import { DynamicBorder, getMarkdownTheme, keyHint } from '@mariozechner/pi-coding-agent';
import { Container, Markdown, Spacer, Text } from '@mariozechner/pi-tui';
import type { Theme, ThemeColor } from '@mariozechner/pi-coding-agent';
import type { SingleAgentResult, UsageStats, FlowDispatchDetails } from './types.js';
import { getDisplayItems, getFinalOutput, aggregateUsage } from './spawn.js';

// ─── Constants ────────────────────────────────────────────────────────────────

export const COLLAPSED_ITEM_COUNT = 10;
export const RUNNING_TOOL_COUNT = 3;
export const TASK_PREVIEW_CHARS = 60;
export const TOOL_DETAIL_CHARS = 60;

// ─── Types ────────────────────────────────────────────────────────────────────

/** Maps (colorName, text) → text. In production: theme.fg(). In tests: identity. */
type Colorize = (color: string, text: string) => string;

/** Maps text → bold text. In production: theme.bold(). In tests: identity. */
type Bold = (text: string) => string;

// ─── Internal helpers ─────────────────────────────────────────────────────────

function shortenPath(p: string): string {
  const home = os.homedir();
  return p.startsWith(home) ? `~${p.slice(home.length)}` : p;
}

// ─── formatTokens ─────────────────────────────────────────────────────────────

/**
 * Human-readable token count:
 *   <1k     → raw number ("999")
 *   <10k    → one decimal ("1.2k")
 *   <1M     → rounded k ("45k")
 *   ≥1M     → one decimal M ("1.5M")
 */
export function formatTokens(count: number): string {
  if (count < 1_000) return count.toString();
  if (count < 10_000) return `${(count / 1_000).toFixed(1)}k`;
  if (count < 1_000_000) return `${Math.round(count / 1_000)}k`;
  return `${(count / 1_000_000).toFixed(1)}M`;
}

// ─── formatToolCall ───────────────────────────────────────────────────────────

/**
 * Formats a tool call as a short readable line.
 *
 *   read ~/src/auth/token.ts:1-80
 *   $ git status
 *   write ~/src/file.ts (45 lines)
 *   edit ~/src/auth/token.ts
 *   grep /refreshToken/ in ~/src/auth/
 *   find *.ts in ~/src/
 *   ls ~/src/
 *   custom_tool first string arg...
 */
export function formatToolCall(
  toolName: string,
  args: Record<string, unknown>,
  colorize: Colorize,
): string {
  switch (toolName) {
    case 'read': {
      const rawPath = (args.file_path ?? args.path ?? '...') as string;
      const filePath = shortenPath(rawPath);
      const offset = args.offset as number | undefined;
      const limit = args.limit as number | undefined;
      let text = colorize('accent', filePath);
      if (offset !== undefined || limit !== undefined) {
        const startLine = offset ?? 1;
        const endLine = limit !== undefined ? startLine + limit - 1 : '';
        text += colorize('warning', `:${startLine}${endLine !== '' ? `-${endLine}` : ''}`);
      }
      return colorize('muted', 'read ') + text;
    }
    case 'bash': {
      const command = (args.command as string) ?? '...';
      const preview =
        command.length > TOOL_DETAIL_CHARS ? `${command.slice(0, TOOL_DETAIL_CHARS)}...` : command;
      return colorize('muted', '$ ') + colorize('toolOutput', preview);
    }
    case 'write': {
      const rawPath = (args.file_path ?? args.path ?? '...') as string;
      const filePath = shortenPath(rawPath);
      const content = (args.content ?? '') as string;
      const lines = content.split('\n').length;
      let text = colorize('muted', 'write ') + colorize('accent', filePath);
      if (lines > 1) text += colorize('dim', ` (${lines} lines)`);
      return text;
    }
    case 'edit': {
      const rawPath = (args.file_path ?? args.path ?? '...') as string;
      return colorize('muted', 'edit ') + colorize('accent', shortenPath(rawPath));
    }
    case 'ls': {
      const rawPath = (args.path ?? '.') as string;
      return colorize('muted', 'ls ') + colorize('accent', shortenPath(rawPath));
    }
    case 'find': {
      const pattern = (args.pattern ?? '*') as string;
      const rawPath = (args.path ?? '.') as string;
      return (
        colorize('muted', 'find ') +
        colorize('accent', pattern) +
        colorize('dim', ` in ${shortenPath(rawPath)}`)
      );
    }
    case 'grep': {
      const pattern = (args.pattern ?? '') as string;
      const rawPath = (args.path ?? '.') as string;
      return (
        colorize('muted', 'grep ') +
        colorize('accent', `/${pattern}/`) +
        colorize('dim', ` in ${shortenPath(rawPath)}`)
      );
    }
    default: {
      const firstStringArg = Object.values(args).find((v): v is string => typeof v === 'string');
      const preview = firstStringArg
        ? firstStringArg.length > TOOL_DETAIL_CHARS
          ? `${firstStringArg.slice(0, TOOL_DETAIL_CHARS)}...`
          : firstStringArg
        : '';
      return colorize('accent', toolName) + (preview ? colorize('dim', ` ${preview}`) : '');
    }
  }
}

// ─── formatUsageStats ─────────────────────────────────────────────────────────

/**
 * Compact usage summary: "3 turns ↑1.2k ↓450 R45k $0.0234 claude-sonnet-4-6"
 * Omits zero/empty fields.
 */
export function formatUsageStats(usage: UsageStats, model?: string): string {
  const parts: string[] = [];
  if (usage.turns) parts.push(`${usage.turns} turn${usage.turns > 1 ? 's' : ''}`);
  if (usage.input) parts.push(`↑${formatTokens(usage.input)}`);
  if (usage.output) parts.push(`↓${formatTokens(usage.output)}`);
  if (usage.cacheRead) parts.push(`R${formatTokens(usage.cacheRead)}`);
  if (usage.cacheWrite) parts.push(`W${formatTokens(usage.cacheWrite)}`);
  if (usage.cost) parts.push(`$${usage.cost.toFixed(4)}`);
  if (usage.contextTokens && usage.contextTokens > 0)
    parts.push(`ctx:${formatTokens(usage.contextTokens)}`);
  if (model) parts.push(model);
  return parts.join(' ');
}

// ─── formatElapsed ────────────────────────────────────────────────────────────

/**
 * Elapsed time from a start epoch-ms timestamp.
 * Format: "0:42" (M:SS) or "1:23:45" (H:MM:SS).
 */
export function formatElapsed(startMs: number): string {
  const totalSecs = Math.floor((Date.now() - startMs) / 1000);
  const hours = Math.floor(totalSecs / 3600);
  const mins = Math.floor((totalSecs % 3600) / 60);
  const secs = totalSecs % 60;
  if (hours > 0) {
    return `${hours}:${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
  }
  return `${mins}:${secs.toString().padStart(2, '0')}`;
}

// ─── renderSingleCall ─────────────────────────────────────────────────────────

/**
 * Renders the dispatch_flow call header for single mode.
 *
 *   dispatch_flow scout [builtin]
 *     Map auth module — models, routes...
 */
export function renderSingleCall(
  agentName: string,
  task: string,
  scope: string,
  colorize: Colorize,
  bold: Bold,
): string {
  const preview =
    task.length > TASK_PREVIEW_CHARS ? `${task.slice(0, TASK_PREVIEW_CHARS)}...` : task;
  let text =
    colorize('toolTitle', bold('dispatch_flow ')) +
    colorize('accent', agentName) +
    colorize('muted', ` [${scope}]`);
  text += `\n  ${colorize('dim', preview)}`;
  return text;
}

// ─── renderParallelCall ───────────────────────────────────────────────────────

/**
 * Renders the dispatch_flow call header for parallel mode.
 *
 *   dispatch_flow parallel (3 tasks) [builtin]
 *     scout Map frontend architecture...
 *     scout Map backend API layer...
 *     scout Map test coverage...
 */
export function renderParallelCall(
  tasks: Array<{ agent: string; task: string }>,
  scope: string,
  colorize: Colorize,
  bold: Bold,
): string {
  let text =
    colorize('toolTitle', bold('dispatch_flow ')) +
    colorize('accent', `parallel (${tasks.length} tasks)`) +
    colorize('muted', ` [${scope}]`);
  for (const t of tasks.slice(0, 3)) {
    const preview =
      t.task.length > TASK_PREVIEW_CHARS ? `${t.task.slice(0, TASK_PREVIEW_CHARS)}...` : t.task;
    text += `\n  ${colorize('accent', t.agent)}${colorize('dim', ` ${preview}`)}`;
  }
  if (tasks.length > 3) {
    text += `\n  ${colorize('muted', `... +${tasks.length - 3} more`)}`;
  }
  return text;
}

// ─── renderChainCall ──────────────────────────────────────────────────────────

/**
 * Renders the dispatch_flow call header for chain mode.
 *
 *   dispatch_flow chain (3 steps) [builtin]
 *     1. scout Find all payment endpoints...
 *     2. planner Design payment refactor...
 *     3. planner Break design into tasks...
 */
export function renderChainCall(
  steps: Array<{ agent: string; task: string }>,
  scope: string,
  colorize: Colorize,
  bold: Bold,
): string {
  let text =
    colorize('toolTitle', bold('dispatch_flow ')) +
    colorize('accent', `chain (${steps.length} steps)`) +
    colorize('muted', ` [${scope}]`);
  for (let i = 0; i < Math.min(steps.length, 3); i++) {
    const step = steps[i];
    const cleanTask = step.task.replace(/\{previous\}/g, '').trim();
    const preview =
      cleanTask.length > TASK_PREVIEW_CHARS
        ? `${cleanTask.slice(0, TASK_PREVIEW_CHARS)}...`
        : cleanTask;
    text +=
      `\n  ${colorize('muted', `${i + 1}.`)} ` +
      colorize('accent', step.agent) +
      colorize('dim', ` ${preview}`);
  }
  if (steps.length > 3) {
    text += `\n  ${colorize('muted', `... +${steps.length - 3} more`)}`;
  }
  return text;
}

// ─── renderAgentCard ──────────────────────────────────────────────────────────

/**
 * Renders a single agent's result as a text card. Four states:
 *
 *   QUEUED  (exitCode=-1, no messages):
 *     ○ builder (builtin)
 *       Implement task...
 *       waiting...
 *
 *   RUNNING (exitCode=-1, has messages):
 *     ● builder  0:42 · turn 3
 *       Implement task...
 *       → read ~/src/auth/token.ts
 *
 *   DONE COLLAPSED:
 *     ✓ builder (builtin)
 *       Implement task...
 *       → read ~/src/auth/token.ts:1-80
 *       5 turns ↑12k ↓4.1k $0.0234
 *
 *   DONE EXPANDED:
 *     ✓ builder (builtin)
 *
 *     ─── Task ───
 *       Implement task...
 *
 *     ─── Output ───
 *       → read ~/src/auth/token.ts:1-80
 *
 *       Final markdown output here...
 *
 *       5 turns ↑12k ↓4.1k $0.0234
 *
 *   ERROR:
 *     ✗ builder (builtin) [error]
 *       Implement task...
 *       Error: Process exited with code 1
 *       TypeError: foo
 */
export function renderAgentCard(
  result: SingleAgentResult,
  expanded: boolean,
  colorize: Colorize,
  bold: Bold,
): string {
  const isRunning = result.exitCode === -1;
  const isQueued = isRunning && result.messages.length === 0;
  const isError =
    !isRunning &&
    (result.exitCode !== 0 || result.stopReason === 'error' || result.stopReason === 'aborted');

  // ── Header line ────────────────────────────────────────────────────────────
  let header: string;

  if (isQueued) {
    header =
      colorize('dim', '○') +
      ' ' +
      colorize('accent', result.agent) +
      colorize('muted', ` (${result.agentSource})`);
  } else if (isRunning) {
    header = colorize('warning', '●') + ' ' + colorize('accent', bold(result.agent));
    if (result.startedAt) {
      header += colorize(
        'dim',
        `  ${formatElapsed(result.startedAt)} · turn ${result.usage.turns}`,
      );
    } else if (result.usage.turns > 0) {
      header += colorize('dim', `  turn ${result.usage.turns}`);
    }
  } else if (isError) {
    header =
      colorize('error', '✗') +
      ' ' +
      colorize('accent', bold(result.agent)) +
      colorize('muted', ` (${result.agentSource})`);
    if (result.stopReason) {
      header += ` ${colorize('error', `[${result.stopReason}]`)}`;
    }
  } else {
    // Done
    header =
      colorize('success', '✓') +
      ' ' +
      colorize('accent', bold(result.agent)) +
      colorize('muted', ` (${result.agentSource})`);
  }

  let text = header;

  const taskPreview =
    result.task.length > TASK_PREVIEW_CHARS
      ? `${result.task.slice(0, TASK_PREVIEW_CHARS)}...`
      : result.task;

  // ── Queued ─────────────────────────────────────────────────────────────────
  if (isQueued) {
    text += `\n  ${colorize('dim', taskPreview)}`;
    text += `\n  ${colorize('muted', 'waiting...')}`;
    return text;
  }

  // ── Running ────────────────────────────────────────────────────────────────
  if (isRunning) {
    text += `\n  ${colorize('dim', taskPreview)}`;
    const displayItems = getDisplayItems(result.messages);
    const recentToolCalls = displayItems
      .filter((d) => d.type === 'toolCall')
      .slice(-RUNNING_TOOL_COUNT);
    for (const item of recentToolCalls) {
      if (item.type === 'toolCall') {
        text += `\n  ${colorize('muted', '→ ')}${formatToolCall(item.name, item.args, colorize)}`;
      }
    }
    return text;
  }

  // ── Error ──────────────────────────────────────────────────────────────────
  if (isError) {
    text += `\n  ${colorize('dim', taskPreview)}`;
    if (result.errorMessage) {
      text += `\n  ${colorize('error', `Error: ${result.errorMessage}`)}`;
    }
    const firstStderr = result.stderr.split('\n').find((l) => l.trim());
    if (firstStderr) {
      text += `\n  ${colorize('dim', firstStderr)}`;
    }
    return text;
  }

  // ── Done ───────────────────────────────────────────────────────────────────
  const displayItems = getDisplayItems(result.messages);

  if (expanded) {
    text += `\n\n${colorize('muted', '─── Task ───')}`;
    text += `\n  ${colorize('dim', result.task)}`;
    text += `\n\n${colorize('muted', '─── Output ───')}`;
    for (const item of displayItems) {
      if (item.type === 'toolCall') {
        text += `\n  ${colorize('muted', '→ ')}${formatToolCall(item.name, item.args, colorize)}`;
      }
    }
    const finalOutput = getFinalOutput(result.messages);
    if (finalOutput) {
      text += `\n\n${finalOutput.trim()}`;
    }
    const usageStr = formatUsageStats(result.usage, result.model);
    if (usageStr) text += `\n\n${colorize('dim', usageStr)}`;
  } else {
    text += `\n  ${colorize('dim', taskPreview)}`;
    const toShow = displayItems.slice(-COLLAPSED_ITEM_COUNT);
    const skipped = displayItems.length - toShow.length;
    if (skipped > 0) {
      text += `\n  ${colorize('muted', `... ${skipped} earlier items`)}`;
    }
    for (const item of toShow) {
      if (item.type === 'toolCall') {
        text += `\n  ${colorize('muted', '→ ')}${formatToolCall(item.name, item.args, colorize)}`;
      } else if (item.type === 'text') {
        const preview = item.text.split('\n').slice(0, 3).join('\n');
        text += `\n  ${colorize('toolOutput', preview)}`;
      }
    }
    const usageStr = formatUsageStats(result.usage, result.model);
    if (usageStr) text += `\n  ${colorize('dim', usageStr)}`;
  }

  return text;
}

// ─── renderSingleResult ───────────────────────────────────────────────────────

/**
 * Renders a single-mode result. Wraps renderAgentCard and adds the expand
 * hint when the result is done and collapsed.
 */
export function renderSingleResult(
  result: SingleAgentResult,
  expanded: boolean,
  colorize: Colorize,
  bold: Bold,
): string {
  let text = renderAgentCard(result, expanded, colorize, bold);
  const isDone = result.exitCode !== -1;
  if (isDone && !expanded) {
    text += `\n  ${colorize('muted', '(Ctrl+O to expand)')}`;
  }
  return text;
}

// ─── renderParallelResult ─────────────────────────────────────────────────────

/**
 * Renders a parallel-mode result with a header and one card per agent.
 *
 *   ⏳ parallel 1/3 done, 2 running
 *
 *   ─── scout ✓
 *     ...
 *
 *   ─── scout ●
 *     ...
 *
 *   (Ctrl+O to expand)
 */
export function renderParallelResult(
  results: SingleAgentResult[],
  expanded: boolean,
  colorize: Colorize,
  bold: Bold,
): string {
  const running = results.filter((r) => r.exitCode === -1).length;
  const successCount = results.filter((r) => r.exitCode === 0).length;
  const failCount = results.filter((r) => r.exitCode !== -1 && r.exitCode !== 0).length;
  const isRunning = running > 0;

  const icon = isRunning
    ? colorize('warning', '⏳')
    : failCount > 0
      ? colorize('warning', '◐')
      : colorize('success', '✓');

  const status = isRunning
    ? `${successCount + failCount}/${results.length} done, ${running} running`
    : `${successCount}/${results.length} tasks`;

  let text = `${icon} ${colorize('toolTitle', bold('parallel '))}` + colorize('accent', status);

  for (const r of results) {
    const rIcon =
      r.exitCode === -1
        ? colorize('warning', '⏳')
        : r.exitCode === 0
          ? colorize('success', '✓')
          : colorize('error', '✗');

    text += `\n\n${colorize('muted', '─── ')}${colorize('accent', r.agent)} ${rIcon}`;
    // Append card body — skip the first line (icon+name header from renderAgentCard)
    const cardLines = renderAgentCard(r, expanded, colorize, bold).split('\n');
    if (cardLines.length > 1) {
      text += `\n  ${cardLines.slice(1).join('\n  ')}`;
    }
  }

  if (!isRunning) {
    const total = aggregateUsage(results);
    const totalStr = formatUsageStats(total);
    if (totalStr) text += `\n\n${colorize('dim', `Total: ${totalStr}`)}`;
    if (!expanded) {
      text += `\n${colorize('muted', '(Ctrl+O to expand)')}`;
    }
  }

  return text;
}

// ─── renderChainResult ────────────────────────────────────────────────────────

/**
 * Renders a chain-mode result with a header and numbered step cards.
 *
 *   ✓ chain 3/3 steps
 *
 *   ─── Step 1: scout ✓
 *     ...
 *
 *   ─── Step 2: planner ✓
 *     ...
 *
 *   Total: 5 turns ↑20k ↓4k $0.0312
 *   (Ctrl+O to expand)
 */
export function renderChainResult(
  results: SingleAgentResult[],
  expanded: boolean,
  colorize: Colorize,
  bold: Bold,
): string {
  const runningCount = results.filter((r) => r.exitCode === -1).length;
  const successCount = results.filter((r) => r.exitCode === 0).length;
  const failedResult = results.find((r) => r.exitCode !== -1 && r.exitCode !== 0);
  const totalDone = results.filter((r) => r.exitCode !== -1).length;

  const icon =
    runningCount > 0
      ? colorize('warning', '⏳')
      : successCount === results.length
        ? colorize('success', '✓')
        : colorize('error', '✗');

  let status: string;
  if (runningCount > 0) {
    status = `${totalDone}/${results.length} steps, ${runningCount} running`;
  } else if (failedResult) {
    const failedStep = failedResult.step ?? results.indexOf(failedResult) + 1;
    status = `stopped at step ${failedStep}`;
  } else {
    status = `${successCount}/${results.length} steps`;
  }

  let text = `${icon} ${colorize('toolTitle', bold('chain '))}` + colorize('accent', status);

  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    const stepNum = r.step ?? i + 1;
    const rIcon =
      r.exitCode === -1
        ? colorize('warning', '●')
        : r.exitCode === 0
          ? colorize('success', '✓')
          : colorize('error', '✗');

    text +=
      `\n\n${colorize('muted', `─── Step ${stepNum}: `)}` +
      colorize('accent', r.agent) +
      ` ${rIcon}`;

    // Append card body — skip the first line (icon+name header)
    const cardLines = renderAgentCard(r, expanded, colorize, bold).split('\n');
    if (cardLines.length > 1) {
      text += `\n  ${cardLines.slice(1).join('\n  ')}`;
    }
  }

  if (runningCount === 0) {
    const total = aggregateUsage(results);
    const totalStr = formatUsageStats(total);
    if (totalStr) text += `\n\n${colorize('dim', `Total: ${totalStr}`)}`;
    if (!expanded) {
      text += `\n${colorize('muted', '(Ctrl+O to expand)')}`;
    }
  }

  return text;
}

// ─── buildAgentCardComponent ──────────────────────────────────────────────────

/**
 * Build a single agent card as a Container with DynamicBorder borders.
 * Mirrors pi-crew's buildAgentCard pattern.
 *
 * States:
 *   Queued  (exitCode=-1, no messages): ○ icon + "(waiting...)"
 *   Running (exitCode=-1, has messages): ● icon + turn/tool count + last 3 tool calls
 *   Done collapsed: ✓ icon + last 5 tool calls + output preview + usage
 *   Done expanded:  ✓ icon + all tool calls + Markdown output + usage
 *   Error:  ✗ icon + error summary
 */
export function buildAgentCardComponent(
  result: SingleAgentResult,
  expanded: boolean,
  theme: Theme,
): Container {
  const card = new Container();
  const borderFn = (s: string) => theme.fg('dim', s);

  const isRunning = result.exitCode === -1;
  const isQueued = isRunning && result.messages.length === 0;
  const isError =
    !isRunning &&
    (result.exitCode !== 0 || result.stopReason === 'error' || result.stopReason === 'aborted');

  // Status icon
  const icon = isQueued
    ? theme.fg('dim', '○')
    : isRunning
      ? theme.fg('warning', '●')
      : isError
        ? theme.fg('error', '✗')
        : theme.fg('success', '✓');

  // Header line
  let header: string;
  if (isQueued) {
    header =
      `${icon} ${theme.fg('accent', result.agent)}` + theme.fg('muted', ` (${result.agentSource})`);
  } else if (isRunning) {
    header = `${icon} ${theme.fg('accent', theme.bold(result.agent))}`;
    if (result.startedAt) {
      header += theme.fg(
        'dim',
        `  ${formatElapsed(result.startedAt)} · turn ${result.usage.turns}`,
      );
    } else if (result.usage.turns > 0) {
      header += theme.fg('dim', `  turn ${result.usage.turns}`);
    }
  } else if (isError) {
    header =
      `${icon} ${theme.fg('accent', theme.bold(result.agent))}` +
      theme.fg('muted', ` (${result.agentSource})`);
    if (result.stopReason) {
      header += ` ${theme.fg('error', `[${result.stopReason}]`)}`;
    }
  } else {
    header =
      `${icon} ${theme.fg('accent', theme.bold(result.agent))}` +
      theme.fg('muted', ` (${result.agentSource})`);
  }

  card.addChild(new DynamicBorder(borderFn));
  card.addChild(new Text(header, 0, 0));

  // Task preview
  const taskPreview =
    result.task.length > TASK_PREVIEW_CHARS
      ? `${result.task.slice(0, TASK_PREVIEW_CHARS)}...`
      : result.task;

  const colorize: Colorize = (color, t) => theme.fg(color as ThemeColor, t);
  const displayItems = getDisplayItems(result.messages);

  if (isQueued) {
    card.addChild(new Text(theme.fg('dim', `  ${taskPreview}`), 0, 0));
    card.addChild(new Text(theme.fg('muted', '  waiting...'), 0, 0));
  } else if (isRunning) {
    card.addChild(new Text(theme.fg('dim', `  ${taskPreview}`), 0, 0));
    const toolCalls = displayItems.filter((d) => d.type === 'toolCall');
    const recentTools = toolCalls.slice(-RUNNING_TOOL_COUNT);
    for (const item of recentTools) {
      if (item.type === 'toolCall') {
        card.addChild(
          new Text(
            theme.fg('muted', '  → ') + formatToolCall(item.name, item.args, colorize),
            0,
            0,
          ),
        );
      }
    }
  } else if (isError) {
    card.addChild(new Text(theme.fg('dim', `  ${taskPreview}`), 0, 0));
    if (result.errorMessage) {
      card.addChild(new Text(theme.fg('error', `  Error: ${result.errorMessage}`), 0, 0));
    }
    const firstStderr = result.stderr.split('\n').find((l) => l.trim());
    if (firstStderr) {
      card.addChild(new Text(theme.fg('dim', `  ${firstStderr}`), 0, 0));
    }
  } else if (expanded) {
    // Expanded done: Task section + all tool calls + Markdown output + usage
    card.addChild(new Spacer(1));
    card.addChild(new Text(theme.fg('muted', '─── Task ───'), 0, 0));
    card.addChild(new Text(theme.fg('dim', `  ${result.task}`), 0, 0));
    card.addChild(new Spacer(1));
    card.addChild(new Text(theme.fg('muted', '─── Output ───'), 0, 0));
    for (const item of displayItems) {
      if (item.type === 'toolCall') {
        card.addChild(
          new Text(
            theme.fg('muted', '  → ') + formatToolCall(item.name, item.args, colorize),
            0,
            0,
          ),
        );
      }
    }
    const finalOutput = getFinalOutput(result.messages);
    if (finalOutput) {
      card.addChild(new Spacer(1));
      card.addChild(new Markdown(finalOutput.trim(), 0, 0, getMarkdownTheme()));
    }
    const usageStr = formatUsageStats(result.usage, result.model);
    if (usageStr) {
      card.addChild(new Spacer(1));
      card.addChild(new Text(theme.fg('dim', usageStr), 0, 0));
    }
  } else {
    // Collapsed done: task + last COLLAPSED_ITEM_COUNT items + usage
    card.addChild(new Text(theme.fg('dim', `  ${taskPreview}`), 0, 0));
    const toShow = displayItems.slice(-COLLAPSED_ITEM_COUNT);
    const skipped = displayItems.length - toShow.length;
    if (skipped > 0) {
      card.addChild(new Text(theme.fg('muted', `  ... ${skipped} earlier items`), 0, 0));
    }
    for (const item of toShow) {
      if (item.type === 'toolCall') {
        card.addChild(
          new Text(
            theme.fg('muted', '  → ') + formatToolCall(item.name, item.args, colorize),
            0,
            0,
          ),
        );
      } else if (item.type === 'text') {
        const preview = item.text.split('\n').slice(0, 3).join('\n');
        card.addChild(new Text(theme.fg('toolOutput', `  ${preview}`), 0, 0));
      }
    }
    const usageStr = formatUsageStats(result.usage, result.model);
    if (usageStr) card.addChild(new Text(theme.fg('dim', `  ${usageStr}`), 0, 0));
  }

  card.addChild(new DynamicBorder(borderFn));
  return card;
}

// ─── buildFlowResult ──────────────────────────────────────────────────────────

/**
 * Build the full flow result: stacked agent cards + total usage footer.
 * Mirrors pi-crew's buildRenderResult pattern.
 */
export function buildFlowResult(
  details: FlowDispatchDetails,
  options: { expanded: boolean; isPartial: boolean },
  theme: Theme,
): Container {
  const root = new Container();
  const { expanded, isPartial } = options;

  // Build one agent card per result
  for (const result of details.results) {
    root.addChild(buildAgentCardComponent(result, expanded, theme));
  }

  // Footer: total usage + expand hint (only when not partial)
  if (!isPartial) {
    const total = aggregateUsage(details.results);
    const footerParts: string[] = [];

    if (details.results.length > 1) {
      const totalStr = formatUsageStats(total);
      if (totalStr) footerParts.push(`Total: ${theme.fg('dim', totalStr)}`);
    }

    if (!expanded) {
      try {
        footerParts.push(keyHint('app.tools.expand', 'to expand'));
      } catch {
        // keyHint requires an initialized pi theme — fall back in test/headless contexts
        footerParts.push('(Ctrl+O to expand)');
      }
    }

    if (footerParts.length > 0) {
      root.addChild(new Text(footerParts.join('  '), 0, 0));
    }
  }

  return root;
}


