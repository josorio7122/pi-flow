import { describe, it, expect } from 'vitest';
import * as os from 'node:os';
import type { SingleAgentResult } from './types.js';

// ─── helpers ────────────────────────────────────────────────────────────────

type Colorize = (color: string, text: string) => string;
type Bold = (text: string) => string;

const noColor: Colorize = (_, text) => text;
const noBold: Bold = (text) => text;

const zeroUsage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  cost: 0,
  contextTokens: 0,
  turns: 0,
};

function makeResult(overrides: Partial<SingleAgentResult> = {}): SingleAgentResult {
  return {
    agent: 'builder',
    agentSource: 'builtin',
    task: 'Implement feature X',
    exitCode: 0,
    messages: [],
    stderr: '',
    usage: { ...zeroUsage },
    ...overrides,
  };
}

/** Build an assistant message with tool calls and optional text. */
function makeToolCallMessage(
  toolName: string,
  toolArgs: Record<string, unknown>,
): Record<string, unknown> {
  return {
    role: 'assistant',
    content: [{ type: 'toolCall', name: toolName, arguments: toolArgs }],
  };
}

function makeTextMessage(text: string): Record<string, unknown> {
  return {
    role: 'assistant',
    content: [{ type: 'text', text }],
  };
}

// ─── imports ─────────────────────────────────────────────────────────────────

import {
  COLLAPSED_ITEM_COUNT,
  RUNNING_TOOL_COUNT,
  TASK_PREVIEW_CHARS,
  TOOL_DETAIL_CHARS,
  formatTokens,
  formatToolCall,
  formatUsageStats,
  formatElapsed,
  renderSingleCall,
  renderParallelCall,
  renderChainCall,
  renderAgentCard,
  renderSingleResult,
  renderParallelResult,
  renderChainResult,

  buildAgentCardComponent,
  buildFlowResult,
} from './rendering.js';
import { Container } from '@mariozechner/pi-tui';
import type { FlowDispatchDetails } from './types.js';

// ─── formatTokens ────────────────────────────────────────────────────────────

describe('formatTokens', () => {
  it('returns raw number below 1k', () => {
    expect(formatTokens(0)).toBe('0');
    expect(formatTokens(1)).toBe('1');
    expect(formatTokens(999)).toBe('999');
  });

  it('returns N.Nk for 1k–9.9k range', () => {
    expect(formatTokens(1000)).toBe('1.0k');
    expect(formatTokens(1234)).toBe('1.2k');
    expect(formatTokens(9500)).toBe('9.5k');
  });

  it('returns Nk for 10k–999k range', () => {
    expect(formatTokens(10000)).toBe('10k');
    expect(formatTokens(45000)).toBe('45k');
    expect(formatTokens(100000)).toBe('100k');
  });

  it('returns N.NM for ≥1M', () => {
    expect(formatTokens(1_000_000)).toBe('1.0M');
    expect(formatTokens(1_500_000)).toBe('1.5M');
    expect(formatTokens(2_000_000)).toBe('2.0M');
  });
});

// ─── formatToolCall ───────────────────────────────────────────────────────────

describe('formatToolCall', () => {
  const home = os.homedir();

  it('formats read with path', () => {
    const result = formatToolCall('read', { path: `${home}/src/auth/token.ts` }, noColor);
    expect(result).toBe('read ~/src/auth/token.ts');
  });

  it('formats read with path and offset+limit', () => {
    const result = formatToolCall(
      'read',
      { path: `${home}/src/file.ts`, offset: 1, limit: 80 },
      noColor,
    );
    expect(result).toBe('read ~/src/file.ts:1-80');
  });

  it('formats read with offset only', () => {
    const result = formatToolCall('read', { path: `${home}/src/file.ts`, offset: 42 }, noColor);
    expect(result).toBe('read ~/src/file.ts:42');
  });

  it('formats read using file_path key', () => {
    const result = formatToolCall('read', { file_path: `${home}/src/file.ts` }, noColor);
    expect(result).toBe('read ~/src/file.ts');
  });

  it('formats bash with short command', () => {
    const result = formatToolCall('bash', { command: 'git status' }, noColor);
    expect(result).toBe('$ git status');
  });

  it('truncates bash command at TOOL_DETAIL_CHARS', () => {
    const longCmd = 'a'.repeat(70);
    const result = formatToolCall('bash', { command: longCmd }, noColor);
    expect(result).toBe(`$ ${'a'.repeat(TOOL_DETAIL_CHARS)}...`);
  });

  it('formats write with line count', () => {
    const content = 'line1\nline2\nline3\nline4\nline5';
    const result = formatToolCall('write', { path: `${home}/src/file.ts`, content }, noColor);
    expect(result).toBe('write ~/src/file.ts (5 lines)');
  });

  it('formats write with single line (no line count)', () => {
    const result = formatToolCall(
      'write',
      { path: `${home}/src/file.ts`, content: 'single' },
      noColor,
    );
    expect(result).toBe('write ~/src/file.ts');
  });

  it('formats edit', () => {
    const result = formatToolCall('edit', { path: `${home}/src/auth/token.ts` }, noColor);
    expect(result).toBe('edit ~/src/auth/token.ts');
  });

  it('formats grep', () => {
    const result = formatToolCall(
      'grep',
      { pattern: 'refreshToken', path: `${home}/src/auth/` },
      noColor,
    );
    expect(result).toBe('grep /refreshToken/ in ~/src/auth/');
  });

  it('formats find', () => {
    const result = formatToolCall('find', { pattern: '*.ts', path: `${home}/src/` }, noColor);
    expect(result).toBe('find *.ts in ~/src/');
  });

  it('formats ls', () => {
    const result = formatToolCall('ls', { path: `${home}/src/` }, noColor);
    expect(result).toBe('ls ~/src/');
  });

  it('shortens absolute path not under home', () => {
    const result = formatToolCall('ls', { path: '/usr/local/bin/' }, noColor);
    expect(result).toBe('ls /usr/local/bin/');
  });

  it('formats generic tool with first string arg', () => {
    const result = formatToolCall('custom_tool', { query: 'find auth endpoints' }, noColor);
    expect(result).toBe('custom_tool find auth endpoints');
  });

  it('truncates generic tool first string arg at TOOL_DETAIL_CHARS', () => {
    const longArg = 'x'.repeat(70);
    const result = formatToolCall('custom_tool', { query: longArg }, noColor);
    expect(result).toBe(`custom_tool ${'x'.repeat(TOOL_DETAIL_CHARS)}...`);
  });

  it('formats generic tool with no string args', () => {
    const result = formatToolCall('custom_tool', { count: 42 }, noColor);
    expect(result).toBe('custom_tool');
  });

  it('applies colorize to tool parts', () => {
    const calls: Array<[string, string]> = [];
    const trackColor: Colorize = (color, text) => {
      calls.push([color, text]);
      return text;
    };
    formatToolCall('read', { path: '/tmp/file.ts' }, trackColor);
    expect(calls.some(([c]) => c === 'muted')).toBe(true);
    expect(calls.some(([c]) => c === 'accent')).toBe(true);
  });
});

// ─── formatUsageStats ────────────────────────────────────────────────────────

describe('formatUsageStats', () => {
  it('returns empty string for zero usage', () => {
    expect(formatUsageStats(zeroUsage)).toBe('');
  });

  it('formats single turn', () => {
    expect(formatUsageStats({ ...zeroUsage, turns: 1 })).toBe('1 turn');
  });

  it('formats multiple turns', () => {
    expect(formatUsageStats({ ...zeroUsage, turns: 3 })).toBe('3 turns');
  });

  it('formats input tokens', () => {
    expect(formatUsageStats({ ...zeroUsage, input: 1200 })).toBe('↑1.2k');
  });

  it('formats output tokens', () => {
    expect(formatUsageStats({ ...zeroUsage, output: 450 })).toBe('↓450');
  });

  it('formats cache read', () => {
    expect(formatUsageStats({ ...zeroUsage, cacheRead: 45000 })).toBe('R45k');
  });

  it('formats cache write', () => {
    expect(formatUsageStats({ ...zeroUsage, cacheWrite: 1000 })).toBe('W1.0k');
  });

  it('formats cost', () => {
    expect(formatUsageStats({ ...zeroUsage, cost: 0.0234 })).toBe('$0.0234');
  });

  it('formats contextTokens', () => {
    expect(formatUsageStats({ ...zeroUsage, contextTokens: 50000 })).toBe('ctx:50k');
  });

  it('includes model name', () => {
    expect(formatUsageStats({ ...zeroUsage, turns: 2 }, 'claude-sonnet-4-6')).toBe(
      '2 turns claude-sonnet-4-6',
    );
  });

  it('formats full usage stats', () => {
    const usage = {
      input: 1200,
      output: 450,
      cacheRead: 45000,
      cacheWrite: 0,
      cost: 0.0234,
      contextTokens: 0,
      turns: 3,
    };
    const result = formatUsageStats(usage);
    expect(result).toBe('3 turns ↑1.2k ↓450 R45k $0.0234');
  });

  it('skips zero fields', () => {
    const result = formatUsageStats({ ...zeroUsage, turns: 2, cost: 0.01 });
    expect(result).toBe('2 turns $0.0100');
    expect(result).not.toContain('↑');
    expect(result).not.toContain('↓');
  });
});

// ─── formatElapsed ────────────────────────────────────────────────────────────

describe('formatElapsed', () => {
  it('formats 0 seconds', () => {
    expect(formatElapsed(Date.now())).toBe('0:00');
  });

  it('formats sub-minute elapsed', () => {
    expect(formatElapsed(Date.now() - 42_000)).toBe('0:42');
  });

  it('formats exactly one minute', () => {
    expect(formatElapsed(Date.now() - 60_000)).toBe('1:00');
  });

  it('formats multi-minute elapsed', () => {
    expect(formatElapsed(Date.now() - 83_000)).toBe('1:23');
  });

  it('formats over one hour', () => {
    // 1 hour + 23 min + 45 sec = 5025 seconds
    expect(formatElapsed(Date.now() - 5_025_000)).toBe('1:23:45');
  });

  it('pads seconds with leading zero', () => {
    expect(formatElapsed(Date.now() - 65_000)).toBe('1:05');
  });
});

// ─── renderSingleCall ─────────────────────────────────────────────────────────

describe('renderSingleCall', () => {
  it('includes dispatch_flow, agent name, scope, and task', () => {
    const result = renderSingleCall('scout', 'Map auth module', 'builtin', noColor, noBold);
    expect(result).toContain('dispatch_flow');
    expect(result).toContain('scout');
    expect(result).toContain('[builtin]');
    expect(result).toContain('Map auth module');
  });

  it('formats as two lines', () => {
    const result = renderSingleCall('scout', 'Map auth module', 'user', noColor, noBold);
    const lines = result.split('\n');
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain('dispatch_flow');
    expect(lines[1]).toContain('Map auth module');
  });

  it('truncates long task at TASK_PREVIEW_CHARS', () => {
    const longTask = 'a'.repeat(70);
    const result = renderSingleCall('scout', longTask, 'user', noColor, noBold);
    expect(result).toContain(`${'a'.repeat(TASK_PREVIEW_CHARS)}...`);
    expect(result).not.toContain('a'.repeat(70));
  });

  it('does not truncate task within limit', () => {
    const shortTask = 'a'.repeat(60);
    const result = renderSingleCall('scout', shortTask, 'user', noColor, noBold);
    expect(result).toContain(shortTask);
    expect(result).not.toContain('...');
  });

  it('applies bold to dispatch_flow', () => {
    const calls: string[] = [];
    const trackBold: Bold = (text) => {
      calls.push(text);
      return text;
    };
    renderSingleCall('scout', 'task', 'user', noColor, trackBold);
    expect(calls.some((t) => t.includes('dispatch_flow'))).toBe(true);
  });
});

// ─── renderParallelCall ───────────────────────────────────────────────────────

describe('renderParallelCall', () => {
  const tasks = [
    { agent: 'scout', task: 'Map frontend architecture' },
    { agent: 'scout', task: 'Map backend API layer' },
    { agent: 'scout', task: 'Map test coverage' },
  ];

  it('includes parallel count and scope', () => {
    const result = renderParallelCall(tasks, 'builtin', noColor, noBold);
    expect(result).toContain('parallel (3 tasks)');
    expect(result).toContain('[builtin]');
  });

  it('shows all tasks when 3 or fewer', () => {
    const result = renderParallelCall(tasks, 'user', noColor, noBold);
    expect(result).toContain('Map frontend architecture');
    expect(result).toContain('Map backend API layer');
    expect(result).toContain('Map test coverage');
  });

  it('shows first 3 tasks and overflow hint when more than 3', () => {
    const manyTasks = [
      { agent: 'scout', task: 'Task 1' },
      { agent: 'scout', task: 'Task 2' },
      { agent: 'scout', task: 'Task 3' },
      { agent: 'scout', task: 'Task 4' },
      { agent: 'scout', task: 'Task 5' },
    ];
    const result = renderParallelCall(manyTasks, 'user', noColor, noBold);
    expect(result).toContain('Task 1');
    expect(result).toContain('Task 2');
    expect(result).toContain('Task 3');
    expect(result).not.toContain('Task 4');
    expect(result).toContain('... +2 more');
  });

  it('truncates long task previews', () => {
    const longTask = 'x'.repeat(70);
    const result = renderParallelCall(
      [{ agent: 'scout', task: longTask }],
      'user',
      noColor,
      noBold,
    );
    expect(result).toContain('x'.repeat(TASK_PREVIEW_CHARS) + '...');
  });
});

// ─── renderChainCall ──────────────────────────────────────────────────────────

describe('renderChainCall', () => {
  const steps = [
    { agent: 'scout', task: 'Find all payment endpoints' },
    { agent: 'strategist', task: 'Design payment refactor' },
    { agent: 'planner', task: 'Break design into waves' },
  ];

  it('includes chain count and scope', () => {
    const result = renderChainCall(steps, 'builtin', noColor, noBold);
    expect(result).toContain('chain (3 steps)');
    expect(result).toContain('[builtin]');
  });

  it('shows steps with sequential numbering', () => {
    const result = renderChainCall(steps, 'user', noColor, noBold);
    expect(result).toContain('1.');
    expect(result).toContain('2.');
    expect(result).toContain('3.');
    expect(result).toContain('scout');
    expect(result).toContain('strategist');
    expect(result).toContain('planner');
  });

  it('cleans up {previous} placeholder from task text', () => {
    const stepsWithPrev = [{ agent: 'strategist', task: 'Design based on {previous} output' }];
    const result = renderChainCall(stepsWithPrev, 'user', noColor, noBold);
    expect(result).not.toContain('{previous}');
    expect(result).toContain('Design based on');
  });

  it('shows overflow hint when more than 3 steps', () => {
    const manySteps = [
      { agent: 'scout', task: 'Step 1' },
      { agent: 'scout', task: 'Step 2' },
      { agent: 'scout', task: 'Step 3' },
      { agent: 'scout', task: 'Step 4' },
    ];
    const result = renderChainCall(manySteps, 'user', noColor, noBold);
    expect(result).not.toContain('Step 4');
    expect(result).toContain('... +1 more');
  });
});

// ─── renderAgentCard ──────────────────────────────────────────────────────────

describe('renderAgentCard', () => {
  describe('queued state (exitCode=-1, no messages)', () => {
    it('shows queued icon and agent name', () => {
      const result = makeResult({ exitCode: -1, messages: [] });
      const card = renderAgentCard(result, false, noColor, noBold);
      expect(card).toContain('○');
      expect(card).toContain('builder');
    });

    it('shows waiting status', () => {
      const result = makeResult({ exitCode: -1, messages: [] });
      const card = renderAgentCard(result, false, noColor, noBold);
      expect(card).toContain('waiting...');
    });

    it('shows task preview', () => {
      const result = makeResult({ exitCode: -1, messages: [], task: 'Implement JWT refresh' });
      const card = renderAgentCard(result, false, noColor, noBold);
      expect(card).toContain('Implement JWT refresh');
    });
  });

  describe('running state (exitCode=-1, has messages)', () => {
    it('shows running icon', () => {
      const result = makeResult({
        exitCode: -1,
        messages: [makeToolCallMessage('read', { path: '/tmp/file.ts' })],
        usage: { ...zeroUsage, turns: 2 },
      });
      const card = renderAgentCard(result, false, noColor, noBold);
      expect(card).toContain('●');
      expect(card).not.toContain('○');
    });

    it('shows turn count when no startedAt', () => {
      const result = makeResult({
        exitCode: -1,
        messages: [makeToolCallMessage('read', { path: '/tmp/file.ts' })],
        usage: { ...zeroUsage, turns: 3 },
      });
      const card = renderAgentCard(result, false, noColor, noBold);
      expect(card).toContain('turn 3');
    });

    it('shows elapsed time when startedAt is set', () => {
      const result = makeResult({
        exitCode: -1,
        messages: [makeToolCallMessage('read', { path: '/tmp/file.ts' })],
        usage: { ...zeroUsage, turns: 2 },
        startedAt: Date.now() - 42_000,
      });
      const card = renderAgentCard(result, false, noColor, noBold);
      expect(card).toContain('0:42');
    });

    it('shows last RUNNING_TOOL_COUNT tool calls', () => {
      const messages = [
        makeToolCallMessage('read', { path: '/tmp/a.ts' }),
        makeToolCallMessage('grep', { pattern: 'foo', path: '/tmp/' }),
        makeToolCallMessage('edit', { path: '/tmp/b.ts' }),
        makeToolCallMessage('write', { path: '/tmp/c.ts', content: 'x\ny\nz' }),
      ];
      const result = makeResult({ exitCode: -1, messages, usage: { ...zeroUsage, turns: 4 } });
      const card = renderAgentCard(result, false, noColor, noBold);
      // Should NOT show read (4th from end out of RUNNING_TOOL_COUNT=3)
      expect(card).not.toContain('read');
      expect(card).toContain('grep');
      expect(card).toContain('edit');
      expect(card).toContain('write');
    });
  });

  describe('done state (exitCode=0)', () => {
    it('shows success icon', () => {
      const result = makeResult({ exitCode: 0 });
      const card = renderAgentCard(result, false, noColor, noBold);
      expect(card).toContain('✓');
    });

    it('shows agent source', () => {
      const result = makeResult({ exitCode: 0, agentSource: 'builtin' });
      const card = renderAgentCard(result, false, noColor, noBold);
      expect(card).toContain('(builtin)');
    });

    it('shows task preview in collapsed mode', () => {
      const result = makeResult({ exitCode: 0, task: 'Build the auth module' });
      const card = renderAgentCard(result, false, noColor, noBold);
      expect(card).toContain('Build the auth module');
    });

    it('shows tool calls in collapsed mode', () => {
      const messages = [makeToolCallMessage('read', { path: '/tmp/file.ts' })];
      const result = makeResult({ exitCode: 0, messages });
      const card = renderAgentCard(result, false, noColor, noBold);
      expect(card).toContain('read');
    });

    it('shows only last COLLAPSED_ITEM_COUNT items in collapsed mode', () => {
      // Create 12 tool calls: first 2 should be cut, last 10 should show
      // Use prefix 'early_' and 'late_' to avoid substring collisions
      const earlyMessages = [
        makeToolCallMessage('bash', { command: 'early_alpha' }),
        makeToolCallMessage('bash', { command: 'early_beta' }),
      ];
      const lateMessages = Array.from({ length: 10 }, (_, i) =>
        makeToolCallMessage('bash', { command: `late_${i}` }),
      );
      const messages = [...earlyMessages, ...lateMessages];
      const result = makeResult({ exitCode: 0, messages });
      const card = renderAgentCard(result, false, noColor, noBold);
      // The 2 early items should be cut off
      expect(card).not.toContain('early_alpha');
      expect(card).not.toContain('early_beta');
      // The last 10 items should appear
      expect(card).toContain('late_9');
      expect(card).toContain('... 2 earlier items');
    });

    it('shows usage stats', () => {
      const result = makeResult({
        exitCode: 0,
        usage: { ...zeroUsage, turns: 5, input: 12000, output: 4100, cost: 0.0234 },
        model: 'claude-sonnet-4-6',
      });
      const card = renderAgentCard(result, false, noColor, noBold);
      expect(card).toContain('5 turns');
      expect(card).toContain('↑12k');
      expect(card).toContain('↓4.1k');
      expect(card).toContain('$0.0234');
    });

    it('shows task in section headers in expanded mode', () => {
      const result = makeResult({ exitCode: 0, task: 'Build the auth module' });
      const card = renderAgentCard(result, true, noColor, noBold);
      expect(card).toContain('─── Task ───');
      expect(card).toContain('Build the auth module');
    });

    it('shows output section header in expanded mode', () => {
      const result = makeResult({ exitCode: 0 });
      const card = renderAgentCard(result, true, noColor, noBold);
      expect(card).toContain('─── Output ───');
    });

    it('shows all tool calls in expanded mode', () => {
      const messages = Array.from({ length: 12 }, (_, i) =>
        makeToolCallMessage('bash', { command: `cmd_${i}` }),
      );
      const result = makeResult({ exitCode: 0, messages });
      const card = renderAgentCard(result, true, noColor, noBold);
      expect(card).toContain('cmd_0');
      expect(card).toContain('cmd_11');
    });

    it('includes final text output in expanded mode', () => {
      const messages = [makeTextMessage('## Summary\n\nImplemented the feature.')];
      const result = makeResult({ exitCode: 0, messages });
      const card = renderAgentCard(result, true, noColor, noBold);
      expect(card).toContain('## Summary');
      expect(card).toContain('Implemented the feature.');
    });
  });

  describe('error state', () => {
    it('shows error icon', () => {
      const result = makeResult({ exitCode: 1 });
      const card = renderAgentCard(result, false, noColor, noBold);
      expect(card).toContain('✗');
    });

    it('shows stopReason when present', () => {
      const result = makeResult({ exitCode: 1, stopReason: 'error' });
      const card = renderAgentCard(result, false, noColor, noBold);
      expect(card).toContain('[error]');
    });

    it('shows errorMessage when present', () => {
      const result = makeResult({ exitCode: 1, errorMessage: 'Process exited with code 1' });
      const card = renderAgentCard(result, false, noColor, noBold);
      expect(card).toContain('Error: Process exited with code 1');
    });

    it('shows first line of stderr when present', () => {
      const result = makeResult({
        exitCode: 1,
        stderr: 'TypeError: foo\n  at bar:42\n  at baz:10',
      });
      const card = renderAgentCard(result, false, noColor, noBold);
      expect(card).toContain('TypeError: foo');
      expect(card).not.toContain('at bar:42');
    });

    it('treats aborted stopReason as error', () => {
      const result = makeResult({ exitCode: 0, stopReason: 'aborted' });
      const card = renderAgentCard(result, false, noColor, noBold);
      expect(card).toContain('✗');
    });
  });
});

// ─── renderSingleResult ───────────────────────────────────────────────────────

describe('renderSingleResult', () => {
  it('adds expand hint when done and collapsed', () => {
    const result = makeResult({ exitCode: 0 });
    const text = renderSingleResult(result, false, noColor, noBold);
    expect(text).toContain('(Ctrl+O to expand)');
  });

  it('does not add expand hint when expanded', () => {
    const result = makeResult({ exitCode: 0 });
    const text = renderSingleResult(result, true, noColor, noBold);
    expect(text).not.toContain('(Ctrl+O to expand)');
  });

  it('does not add expand hint while running', () => {
    const result = makeResult({ exitCode: -1, messages: [] });
    const text = renderSingleResult(result, false, noColor, noBold);
    expect(text).not.toContain('(Ctrl+O to expand)');
  });

  it('shows error card when exitCode is non-zero', () => {
    const result = makeResult({ exitCode: 1, errorMessage: 'Something went wrong' });
    const text = renderSingleResult(result, false, noColor, noBold);
    expect(text).toContain('✗');
    expect(text).toContain('Something went wrong');
    expect(text).toContain('(Ctrl+O to expand)');
  });
});

// ─── renderParallelResult ─────────────────────────────────────────────────────

describe('renderParallelResult', () => {
  it('shows running header when any agent is running', () => {
    const results = [
      makeResult({ agent: 'scout', exitCode: 0 }),
      makeResult({ agent: 'scout', exitCode: -1, messages: [] }),
    ];
    const text = renderParallelResult(results, false, noColor, noBold);
    expect(text).toContain('⏳');
    expect(text).toContain('running');
  });

  it('shows done header when all agents are done', () => {
    const results = [
      makeResult({ agent: 'scout', exitCode: 0 }),
      makeResult({ agent: 'scout', exitCode: 0 }),
    ];
    const text = renderParallelResult(results, false, noColor, noBold);
    expect(text).toContain('✓');
    expect(text).toContain('2/2 tasks');
  });

  it('shows each agent section', () => {
    const results = [
      makeResult({ agent: 'scout', exitCode: 0 }),
      makeResult({ agent: 'strategist', exitCode: 0 }),
    ];
    const text = renderParallelResult(results, false, noColor, noBold);
    expect(text).toContain('scout');
    expect(text).toContain('strategist');
    expect(text).toContain('─── ');
  });

  it('adds expand hint in collapsed done mode', () => {
    const results = [makeResult({ exitCode: 0 })];
    const text = renderParallelResult(results, false, noColor, noBold);
    expect(text).toContain('(Ctrl+O to expand)');
  });

  it('does not add expand hint while running', () => {
    const results = [makeResult({ exitCode: -1, messages: [] })];
    const text = renderParallelResult(results, false, noColor, noBold);
    expect(text).not.toContain('(Ctrl+O to expand)');
  });

  it('shows total usage when all done', () => {
    const results = [
      makeResult({ exitCode: 0, usage: { ...zeroUsage, turns: 2, input: 1000 } }),
      makeResult({ exitCode: 0, usage: { ...zeroUsage, turns: 3, input: 2000 } }),
    ];
    const text = renderParallelResult(results, false, noColor, noBold);
    expect(text).toContain('Total:');
    expect(text).toContain('5 turns');
  });

  it('shows partial done count during running', () => {
    const results = [
      makeResult({ agent: 'scout', exitCode: 0 }),
      makeResult({ agent: 'scout', exitCode: -1, messages: [] }),
      makeResult({ agent: 'scout', exitCode: -1, messages: [] }),
    ];
    const text = renderParallelResult(results, false, noColor, noBold);
    expect(text).toContain('1/3');
    expect(text).toContain('2 running');
  });
});

// ─── renderChainResult ────────────────────────────────────────────────────────

describe('renderChainResult', () => {
  it('shows success header when all steps done', () => {
    const results = [
      makeResult({ agent: 'scout', exitCode: 0, step: 1 }),
      makeResult({ agent: 'strategist', exitCode: 0, step: 2 }),
    ];
    const text = renderChainResult(results, false, noColor, noBold);
    expect(text).toContain('✓');
    expect(text).toContain('2/2 steps');
  });

  it('shows error header and step when a step fails', () => {
    const results = [
      makeResult({ agent: 'scout', exitCode: 0, step: 1 }),
      makeResult({ agent: 'builder', exitCode: 1, step: 2, errorMessage: 'Build failed' }),
    ];
    const text = renderChainResult(results, false, noColor, noBold);
    expect(text).toContain('✗');
    expect(text).toContain('stopped at step 2');
  });

  it('shows running header when a step is running', () => {
    const results = [
      makeResult({ agent: 'scout', exitCode: 0, step: 1 }),
      makeResult({ agent: 'builder', exitCode: -1, messages: [], step: 2 }),
    ];
    const text = renderChainResult(results, false, noColor, noBold);
    expect(text).toContain('⏳');
    expect(text).toContain('running');
  });

  it('shows step numbers in headers', () => {
    const results = [
      makeResult({ agent: 'scout', exitCode: 0, step: 1 }),
      makeResult({ agent: 'strategist', exitCode: 0, step: 2 }),
    ];
    const text = renderChainResult(results, false, noColor, noBold);
    expect(text).toContain('Step 1:');
    expect(text).toContain('Step 2:');
  });

  it('adds expand hint in collapsed done mode', () => {
    const results = [makeResult({ exitCode: 0, step: 1 })];
    const text = renderChainResult(results, false, noColor, noBold);
    expect(text).toContain('(Ctrl+O to expand)');
  });

  it('does not add expand hint while running', () => {
    const results = [makeResult({ exitCode: -1, messages: [], step: 1 })];
    const text = renderChainResult(results, false, noColor, noBold);
    expect(text).not.toContain('(Ctrl+O to expand)');
  });

  it('shows total usage when all steps done', () => {
    const results = [
      makeResult({ exitCode: 0, step: 1, usage: { ...zeroUsage, turns: 2 } }),
      makeResult({ exitCode: 0, step: 2, usage: { ...zeroUsage, turns: 3 } }),
    ];
    const text = renderChainResult(results, false, noColor, noBold);
    expect(text).toContain('Total:');
    expect(text).toContain('5 turns');
  });

  it('falls back to index-based step number when step is undefined', () => {
    const results = [makeResult({ agent: 'scout', exitCode: 1, errorMessage: 'fail' })];
    const text = renderChainResult(results, false, noColor, noBold);
    expect(text).toContain('stopped at step 1');
  });
});



// ─── constants ────────────────────────────────────────────────────────────────

describe('exported constants', () => {
  it('exports COLLAPSED_ITEM_COUNT = 10', () => {
    expect(COLLAPSED_ITEM_COUNT).toBe(10);
  });

  it('exports RUNNING_TOOL_COUNT = 3', () => {
    expect(RUNNING_TOOL_COUNT).toBe(3);
  });

  it('exports TASK_PREVIEW_CHARS = 60', () => {
    expect(TASK_PREVIEW_CHARS).toBe(60);
  });

  it('exports TOOL_DETAIL_CHARS = 60', () => {
    expect(TOOL_DETAIL_CHARS).toBe(60);
  });
});

// ─── buildAgentCardComponent ──────────────────────────────────────────────────

// Minimal theme stub for Component tests
const stubTheme = {
  fg: (_color: string, text: string) => text,
  bold: (text: string) => text,
};

describe('buildAgentCardComponent', () => {
  it('returns a Container', () => {
    const result = makeResult({ exitCode: 0 });
    const card = buildAgentCardComponent(result, false, stubTheme as any);
    expect(card).toBeInstanceOf(Container);
  });

  it('returns a Container for running state (exitCode=-1, ● icon path)', () => {
    const result = makeResult({
      exitCode: -1,
      messages: [makeToolCallMessage('read', { path: '/tmp/file.ts' })],
      usage: { ...zeroUsage, turns: 2 },
    });
    const card = buildAgentCardComponent(result, false, stubTheme as any);
    expect(card).toBeInstanceOf(Container);
    // Container has children (header + border at minimum)
    expect((card as any).children.length).toBeGreaterThan(0);
  });

  it('running state includes ● icon in rendered text', () => {
    const result = makeResult({
      exitCode: -1,
      messages: [makeToolCallMessage('read', { path: '/tmp/file.ts' })],
      usage: { ...zeroUsage, turns: 1 },
    });
    const card = buildAgentCardComponent(result, false, stubTheme as any);
    // Collect all Text children's text
    const texts = (card as any).children
      .filter((c: any) => c.constructor?.name === 'Text')
      .map((c: any) => c.text ?? c.content ?? '');
    const combined = texts.join('');
    expect(combined).toContain('●');
  });

  it('done state (exitCode=0) includes ✓ icon in rendered text', () => {
    const result = makeResult({ exitCode: 0 });
    const card = buildAgentCardComponent(result, false, stubTheme as any);
    const texts = (card as any).children
      .filter((c: any) => c.constructor?.name === 'Text')
      .map((c: any) => c.text ?? c.content ?? '');
    expect(texts.join('')).toContain('✓');
  });

  it('error state (exitCode=1) includes ✗ icon in rendered text', () => {
    const result = makeResult({ exitCode: 1, errorMessage: 'Build failed' });
    const card = buildAgentCardComponent(result, false, stubTheme as any);
    const texts = (card as any).children
      .filter((c: any) => c.constructor?.name === 'Text')
      .map((c: any) => c.text ?? c.content ?? '');
    expect(texts.join('')).toContain('✗');
  });

  it('queued state (exitCode=-1, no messages) includes ○ icon', () => {
    const result = makeResult({ exitCode: -1, messages: [] });
    const card = buildAgentCardComponent(result, false, stubTheme as any);
    const texts = (card as any).children
      .filter((c: any) => c.constructor?.name === 'Text')
      .map((c: any) => c.text ?? c.content ?? '');
    expect(texts.join('')).toContain('○');
  });

  it('has DynamicBorder children as borders', () => {
    const result = makeResult({ exitCode: 0 });
    const card = buildAgentCardComponent(result, false, stubTheme as any);
    const borders = (card as any).children.filter(
      (c: any) => c.constructor?.name === 'DynamicBorder',
    );
    expect(borders.length).toBeGreaterThanOrEqual(1);
  });

  it('expanded mode returns a Container without throwing', () => {
    const messages = [makeTextMessage('## Final output\n\nDone.')];
    const result = makeResult({ exitCode: 0, messages });
    const card = buildAgentCardComponent(result, true, stubTheme as any);
    expect(card).toBeInstanceOf(Container);
  });
});

// ─── buildFlowResult ─────────────────────────────────────────────────────────

describe('buildFlowResult', () => {
  function makeDetails(
    mode: FlowDispatchDetails['mode'],
    results: SingleAgentResult[],
  ): FlowDispatchDetails {
    return { mode, feature: 'test-feature', results };
  }

  it('returns a Container', () => {
    const details = makeDetails('single', [makeResult({ exitCode: 0 })]);
    const root = buildFlowResult(details, { expanded: false, isPartial: false }, stubTheme as any);
    expect(root).toBeInstanceOf(Container);
  });

  it('has one child per agent card for single mode', () => {
    const details = makeDetails('single', [makeResult({ exitCode: 0 })]);
    const root = buildFlowResult(details, { expanded: false, isPartial: false }, stubTheme as any);
    // 1 agent card + 1 footer text = 2 children minimum
    expect((root as any).children.length).toBeGreaterThanOrEqual(1);
  });

  it('has N child cards for N agents in parallel mode', () => {
    const details = makeDetails('parallel', [
      makeResult({ agent: 'scout', exitCode: 0 }),
      makeResult({ agent: 'scout', exitCode: 0 }),
      makeResult({ agent: 'scout', exitCode: 0 }),
    ]);
    const root = buildFlowResult(details, { expanded: false, isPartial: false }, stubTheme as any);
    // At least 3 Container children (one per agent card)
    const containerChildren = (root as any).children.filter((c: any) => c instanceof Container);
    expect(containerChildren.length).toBe(3);
  });

  it('includes total usage footer when not partial and multiple agents', () => {
    const details = makeDetails('parallel', [
      makeResult({ agent: 'scout', exitCode: 0, usage: { ...zeroUsage, turns: 2, cost: 0.01 } }),
      makeResult({ agent: 'scout', exitCode: 0, usage: { ...zeroUsage, turns: 3, cost: 0.02 } }),
    ]);
    const root = buildFlowResult(details, { expanded: false, isPartial: false }, stubTheme as any);
    const texts = (root as any).children
      .filter((c: any) => c.constructor?.name === 'Text')
      .map((c: any) => c.text ?? c.content ?? '');
    expect(texts.join('')).toContain('Total:');
  });

  it('does not include total footer when isPartial=true', () => {
    const details = makeDetails('parallel', [
      makeResult({ agent: 'scout', exitCode: 0, usage: { ...zeroUsage, turns: 2, cost: 0.01 } }),
      makeResult({ agent: 'scout', exitCode: 0, usage: { ...zeroUsage, turns: 3, cost: 0.02 } }),
    ]);
    const root = buildFlowResult(details, { expanded: false, isPartial: true }, stubTheme as any);
    const texts = (root as any).children
      .filter((c: any) => c.constructor?.name === 'Text')
      .map((c: any) => c.text ?? c.content ?? '');
    expect(texts.join('')).not.toContain('Total:');
  });

  it('includes expand hint in footer when collapsed and not partial', () => {
    const details = makeDetails('single', [makeResult({ exitCode: 0 })]);
    const root = buildFlowResult(details, { expanded: false, isPartial: false }, stubTheme as any);
    const texts = (root as any).children
      .filter((c: any) => c.constructor?.name === 'Text')
      .map((c: any) => c.text ?? c.content ?? '');
    expect(texts.join('')).toContain('to expand');
  });

  it('does not include expand hint when expanded=true', () => {
    const details = makeDetails('single', [makeResult({ exitCode: 0 })]);
    const root = buildFlowResult(details, { expanded: true, isPartial: false }, stubTheme as any);
    const texts = (root as any).children
      .filter((c: any) => c.constructor?.name === 'Text')
      .map((c: any) => c.text ?? c.content ?? '');
    expect(texts.join('')).not.toContain('to expand');
  });
});
