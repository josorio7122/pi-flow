import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import type { SingleAgentResult, UsageStats } from './types.js';

// ─── module-level mocks (hoisted by vitest) ──────────────────────────────────

vi.mock('node:child_process', () => ({
  spawn: vi.fn(),
}));

vi.mock('node:fs', () => {
  const unlinkSync = vi.fn();
  const rmdirSync = vi.fn();
  const existsSync = vi.fn().mockReturnValue(false);
  const promises = {
    mkdtemp: vi.fn().mockResolvedValue('/tmp/pi-flow-test-dir'),
    writeFile: vi.fn().mockResolvedValue(undefined),
  };
  return {
    default: { unlinkSync, rmdirSync, existsSync, promises },
    unlinkSync,
    rmdirSync,
    existsSync,
    promises,
  };
});

// ─── helpers ────────────────────────────────────────────────────────────────

function makeResult(overrides: Partial<SingleAgentResult> = {}): SingleAgentResult {
  return {
    agent: 'builder',
    agentSource: 'builtin',
    task: 'do something',
    exitCode: 0,
    messages: [],
    stderr: '',
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      cost: 0,
      contextTokens: 0,
      turns: 0,
    },
    ...overrides,
  };
}

function makeAssistantMessage(
  text: string,
  toolCalls: Array<{ name: string; arguments: Record<string, unknown> }> = [],
) {
  return {
    role: 'assistant',
    content: [
      { type: 'text', text },
      ...toolCalls.map((tc) => ({ type: 'toolCall', name: tc.name, arguments: tc.arguments })),
    ],
    usage: {
      input: 100,
      output: 50,
      cacheRead: 200,
      cacheWrite: 10,
      cost: { total: 0.005 },
      totalTokens: 360,
    },
    model: 'claude-sonnet-4-6',
    stopReason: 'tool_use',
  };
}

function makeToolResultMessage(toolName: string) {
  return {
    role: 'toolResult',
    toolName,
    content: [{ type: 'text', text: 'result content' }],
  };
}

// ─── imports (will fail until spawn.ts exists) ───────────────────────────────

import {
  buildSpawnArgs,
  processNdjsonLine,
  aggregateUsage,
  getFinalOutput,
  getDisplayItems,
  mapWithConcurrencyLimit,
  getPiInvocation,
  spawnAgent,
} from './spawn.js';

import { spawn as mockSpawn } from 'node:child_process';

import type { FlowAgentConfig } from './types.js';

function makeAgent(overrides: Partial<FlowAgentConfig> = {}): FlowAgentConfig {
  return {
    name: 'builder',
    label: 'Builder',
    description: 'Builds things',
    model: 'claude-sonnet-4-6',
    thinking: 'medium',
    tools: ['read', 'write', 'edit', 'bash'],
    writable: true,
    limits: { max_tokens: 100000, max_steps: 120 },
    variables: ['FEATURE_NAME'],
    writes: ['tasks.md'],
    systemPrompt: '# Builder\n\nYou build things.',
    source: 'builtin',
    filePath: '/fake/path/builder.md',
    ...overrides,
  };
}

// ─── getPiInvocation ────────────────────────────────────────────────────────

describe('getPiInvocation', () => {
  it('returns pi fallback when process.argv[1] does not exist', () => {
    // When process.argv[1] points to a non-existent file, fallback to "pi"
    // We can at least verify the return shape
    const result = getPiInvocation(['--mode', 'json']);
    expect(result).toHaveProperty('command');
    expect(result).toHaveProperty('args');
    expect(Array.isArray(result.args)).toBe(true);
    // The extra args must appear somewhere in the combined invocation
    const combined = [result.command, ...result.args].join(' ');
    expect(combined).toContain('--mode');
    expect(combined).toContain('json');
  });

  it('returns object with command string and args array', () => {
    const result = getPiInvocation([]);
    expect(typeof result.command).toBe('string');
    expect(result.command.length).toBeGreaterThan(0);
    expect(Array.isArray(result.args)).toBe(true);
  });
});

// ─── buildSpawnArgs ──────────────────────────────────────────────────────────

describe('buildSpawnArgs', () => {
  it('builds the standard args array in correct order', () => {
    const agent = makeAgent();
    const args = buildSpawnArgs(agent, 'do the thing', '/tmp/prompt.md');

    expect(args).toEqual([
      '--mode',
      'json',
      '-p',
      '--no-session',
      '--no-extensions',
      '--model',
      'claude-sonnet-4-6',
      '--thinking',
      'medium',
      '--tools',
      'read,write,edit,bash',
      '--append-system-prompt',
      '/tmp/prompt.md',
      'do the thing',
    ]);
  });

  it('joins tools with commas', () => {
    const agent = makeAgent({ tools: ['read', 'grep', 'find'] });
    const args = buildSpawnArgs(agent, 'task', '/tmp/p.md');
    const toolsIdx = args.indexOf('--tools');
    expect(args[toolsIdx + 1]).toBe('read,grep,find');
  });

  it('puts the task string as the last argument', () => {
    const agent = makeAgent();
    const args = buildSpawnArgs(agent, 'my task', '/tmp/p.md');
    expect(args[args.length - 1]).toBe('my task');
  });

  it('puts --append-system-prompt before the task', () => {
    const agent = makeAgent();
    const args = buildSpawnArgs(agent, 'task text', '/tmp/my-prompt.md');
    const promptIdx = args.indexOf('--append-system-prompt');
    expect(args[promptIdx + 1]).toBe('/tmp/my-prompt.md');
    expect(args.indexOf('task text')).toBe(promptIdx + 2);
  });

  it('always includes --no-extensions', () => {
    const agent = makeAgent();
    const args = buildSpawnArgs(agent, 'task', '/tmp/p.md');
    expect(args).toContain('--no-extensions');
  });

  it('always includes --no-session', () => {
    const agent = makeAgent();
    const args = buildSpawnArgs(agent, 'task', '/tmp/p.md');
    expect(args).toContain('--no-session');
  });
});

// ─── processNdjsonLine ───────────────────────────────────────────────────────

describe('processNdjsonLine', () => {
  let result: SingleAgentResult;
  let emitUpdate: ReturnType<typeof vi.fn<() => void>>;

  beforeEach(() => {
    result = makeResult();
    emitUpdate = vi.fn<() => void>();
  });

  it('ignores empty lines', () => {
    processNdjsonLine('', result, emitUpdate);
    processNdjsonLine('   ', result, emitUpdate);
    expect(result.messages).toHaveLength(0);
    expect(emitUpdate).not.toHaveBeenCalled();
  });

  it('ignores non-JSON lines', () => {
    processNdjsonLine('not json at all', result, emitUpdate);
    expect(result.messages).toHaveLength(0);
    expect(emitUpdate).not.toHaveBeenCalled();
  });

  it('ignores unknown event types', () => {
    processNdjsonLine(JSON.stringify({ type: 'unknown_event', data: {} }), result, emitUpdate);
    expect(result.messages).toHaveLength(0);
    expect(emitUpdate).not.toHaveBeenCalled();
  });

  it('handles message_end with assistant role: pushes message', () => {
    const msg = makeAssistantMessage('Hello world');
    const line = JSON.stringify({ type: 'message_end', message: msg });
    processNdjsonLine(line, result, emitUpdate);
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0]).toStrictEqual(msg);
  });

  it('handles message_end with assistant role: increments turns', () => {
    const msg = makeAssistantMessage('Hello');
    const line = JSON.stringify({ type: 'message_end', message: msg });
    processNdjsonLine(line, result, emitUpdate);
    expect(result.usage.turns).toBe(1);
  });

  it('handles message_end with assistant role: accumulates usage', () => {
    const msg = makeAssistantMessage('Hello');
    // msg.usage = { input: 100, output: 50, cacheRead: 200, cacheWrite: 10, cost: { total: 0.005 }, totalTokens: 360 }
    processNdjsonLine(JSON.stringify({ type: 'message_end', message: msg }), result, emitUpdate);
    expect(result.usage.input).toBe(100);
    expect(result.usage.output).toBe(50);
    expect(result.usage.cacheRead).toBe(200);
    expect(result.usage.cacheWrite).toBe(10);
    expect(result.usage.cost).toBeCloseTo(0.005);
  });

  it('handles message_end with assistant role: sets contextTokens to totalTokens', () => {
    const msg = makeAssistantMessage('Hello');
    processNdjsonLine(JSON.stringify({ type: 'message_end', message: msg }), result, emitUpdate);
    expect(result.usage.contextTokens).toBe(360);
  });

  it('handles message_end with assistant role: sets model on first occurrence', () => {
    const msg = makeAssistantMessage('Hello');
    processNdjsonLine(JSON.stringify({ type: 'message_end', message: msg }), result, emitUpdate);
    expect(result.model).toBe('claude-sonnet-4-6');
  });

  it('handles message_end with assistant role: does not override existing model', () => {
    result.model = 'claude-opus-4-6';
    const msg = makeAssistantMessage('Hello');
    processNdjsonLine(JSON.stringify({ type: 'message_end', message: msg }), result, emitUpdate);
    expect(result.model).toBe('claude-opus-4-6');
  });

  it('handles message_end with assistant role: sets stopReason', () => {
    const msg = makeAssistantMessage('Hello');
    // msg.stopReason = 'tool_use'
    processNdjsonLine(JSON.stringify({ type: 'message_end', message: msg }), result, emitUpdate);
    expect(result.stopReason).toBe('tool_use');
  });

  it('handles message_end with assistant role: accumulates usage across multiple turns', () => {
    const msg1 = makeAssistantMessage('Turn 1');
    const msg2 = makeAssistantMessage('Turn 2');
    processNdjsonLine(JSON.stringify({ type: 'message_end', message: msg1 }), result, emitUpdate);
    processNdjsonLine(JSON.stringify({ type: 'message_end', message: msg2 }), result, emitUpdate);
    expect(result.usage.turns).toBe(2);
    expect(result.usage.input).toBe(200);
    expect(result.usage.output).toBe(100);
  });

  it('handles message_end: calls emitUpdate', () => {
    const msg = makeAssistantMessage('Hello');
    processNdjsonLine(JSON.stringify({ type: 'message_end', message: msg }), result, emitUpdate);
    expect(emitUpdate).toHaveBeenCalledOnce();
  });

  it('handles message_end with non-assistant role: pushes message but skips usage', () => {
    const msg = { role: 'user', content: [{ type: 'text', text: 'User turn' }] };
    processNdjsonLine(JSON.stringify({ type: 'message_end', message: msg }), result, emitUpdate);
    expect(result.messages).toHaveLength(1);
    expect(result.usage.turns).toBe(0);
    expect(emitUpdate).toHaveBeenCalledOnce();
  });

  it('handles tool_result_end: pushes message', () => {
    const msg = makeToolResultMessage('read');
    processNdjsonLine(
      JSON.stringify({ type: 'tool_result_end', message: msg }),
      result,
      emitUpdate,
    );
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0]).toStrictEqual(msg);
  });

  it('handles tool_result_end: calls emitUpdate', () => {
    const msg = makeToolResultMessage('bash');
    processNdjsonLine(
      JSON.stringify({ type: 'tool_result_end', message: msg }),
      result,
      emitUpdate,
    );
    expect(emitUpdate).toHaveBeenCalledOnce();
  });

  it('handles tool_result_end: does not change usage stats', () => {
    const msg = makeToolResultMessage('read');
    processNdjsonLine(
      JSON.stringify({ type: 'tool_result_end', message: msg }),
      result,
      emitUpdate,
    );
    expect(result.usage.turns).toBe(0);
    expect(result.usage.input).toBe(0);
  });

  it('handles message_end with missing usage gracefully', () => {
    const msg = { role: 'assistant', content: [{ type: 'text', text: 'Hi' }], stopReason: 'stop' };
    processNdjsonLine(JSON.stringify({ type: 'message_end', message: msg }), result, emitUpdate);
    expect(result.usage.input).toBe(0);
    expect(result.usage.turns).toBe(1);
  });
});

// ─── aggregateUsage ──────────────────────────────────────────────────────────

describe('aggregateUsage', () => {
  it('returns all-zero stats for empty input', () => {
    const stats = aggregateUsage([]);
    expect(stats).toEqual<UsageStats>({
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      cost: 0,
      contextTokens: 0,
      turns: 0,
    });
  });

  it('returns the single result usage when given one result', () => {
    const r = makeResult({
      usage: {
        input: 10,
        output: 5,
        cacheRead: 20,
        cacheWrite: 3,
        cost: 0.01,
        contextTokens: 100,
        turns: 2,
      },
    });
    const stats = aggregateUsage([r]);
    expect(stats.input).toBe(10);
    expect(stats.output).toBe(5);
    expect(stats.turns).toBe(2);
    expect(stats.cost).toBeCloseTo(0.01);
  });

  it('sums input, output, cacheRead, cacheWrite, cost, and turns across results', () => {
    const r1 = makeResult({
      usage: {
        input: 100,
        output: 50,
        cacheRead: 200,
        cacheWrite: 10,
        cost: 0.01,
        contextTokens: 100,
        turns: 3,
      },
    });
    const r2 = makeResult({
      usage: {
        input: 200,
        output: 100,
        cacheRead: 400,
        cacheWrite: 20,
        cost: 0.02,
        contextTokens: 500,
        turns: 5,
      },
    });
    const stats = aggregateUsage([r1, r2]);
    expect(stats.input).toBe(300);
    expect(stats.output).toBe(150);
    expect(stats.cacheRead).toBe(600);
    expect(stats.cacheWrite).toBe(30);
    expect(stats.cost).toBeCloseTo(0.03);
    expect(stats.turns).toBe(8);
  });

  it('uses contextTokens from the last result', () => {
    const r1 = makeResult({
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        cost: 0,
        contextTokens: 100,
        turns: 0,
      },
    });
    const r2 = makeResult({
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        cost: 0,
        contextTokens: 999,
        turns: 0,
      },
    });
    const stats = aggregateUsage([r1, r2]);
    expect(stats.contextTokens).toBe(999);
  });
});

// ─── getFinalOutput ──────────────────────────────────────────────────────────

describe('getFinalOutput', () => {
  it('returns empty string for empty messages array', () => {
    expect(getFinalOutput([])).toBe('');
  });

  it('returns empty string when no assistant messages exist', () => {
    const messages = [
      { role: 'user', content: [{ type: 'text', text: 'Hello' }] },
      { role: 'toolResult', content: [{ type: 'text', text: 'Tool output' }] },
    ];
    expect(getFinalOutput(messages)).toBe('');
  });

  it('returns text from the last assistant message', () => {
    const messages = [
      { role: 'assistant', content: [{ type: 'text', text: 'First response' }] },
      { role: 'toolResult', content: [{ type: 'text', text: 'Tool output' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'Final response' }] },
    ];
    expect(getFinalOutput(messages)).toBe('Final response');
  });

  it('returns the first text block in the last assistant message', () => {
    const messages = [
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'Some text' },
          { type: 'toolCall', name: 'read', arguments: {} },
        ],
      },
    ];
    expect(getFinalOutput(messages)).toBe('Some text');
  });

  it('skips assistant messages with no text content', () => {
    const messages = [
      { role: 'assistant', content: [{ type: 'text', text: 'Earlier text' }] },
      { role: 'assistant', content: [{ type: 'toolCall', name: 'bash', arguments: {} }] },
    ];
    // Last assistant message has no text — should walk back and find the previous one
    expect(getFinalOutput(messages)).toBe('Earlier text');
  });

  it('returns empty string when last assistant has only tool calls', () => {
    const messages = [
      { role: 'assistant', content: [{ type: 'toolCall', name: 'bash', arguments: {} }] },
    ];
    expect(getFinalOutput(messages)).toBe('');
  });
});

// ─── getDisplayItems ─────────────────────────────────────────────────────────

describe('getDisplayItems', () => {
  it('returns empty array for empty messages', () => {
    expect(getDisplayItems([])).toEqual([]);
  });

  it('returns empty array when no assistant messages exist', () => {
    const messages = [{ role: 'user', content: [{ type: 'text', text: 'Hello' }] }];
    expect(getDisplayItems(messages)).toEqual([]);
  });

  it('extracts text blocks from assistant messages', () => {
    const messages = [{ role: 'assistant', content: [{ type: 'text', text: 'My output' }] }];
    const items = getDisplayItems(messages);
    expect(items).toHaveLength(1);
    expect(items[0]).toEqual({ type: 'text', text: 'My output' });
  });

  it('extracts tool calls from assistant messages', () => {
    const messages = [
      {
        role: 'assistant',
        content: [{ type: 'toolCall', name: 'read', arguments: { path: 'foo.ts' } }],
      },
    ];
    const items = getDisplayItems(messages);
    expect(items).toHaveLength(1);
    expect(items[0]).toEqual({ type: 'toolCall', name: 'read', args: { path: 'foo.ts' } });
  });

  it('preserves order of text and toolCall items within a message', () => {
    const messages = [
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'Reading file...' },
          { type: 'toolCall', name: 'read', arguments: { path: 'a.ts' } },
          { type: 'text', text: 'Done.' },
        ],
      },
    ];
    const items = getDisplayItems(messages);
    expect(items).toHaveLength(3);
    expect(items[0]).toEqual({ type: 'text', text: 'Reading file...' });
    expect(items[1]).toEqual({ type: 'toolCall', name: 'read', args: { path: 'a.ts' } });
    expect(items[2]).toEqual({ type: 'text', text: 'Done.' });
  });

  it('collects items from multiple assistant messages in order', () => {
    const messages = [
      { role: 'assistant', content: [{ type: 'text', text: 'Turn 1' }] },
      { role: 'toolResult', content: [{ type: 'text', text: 'Tool output' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'Turn 2' }] },
    ];
    const items = getDisplayItems(messages);
    expect(items).toHaveLength(2);
    expect(items[0]).toEqual({ type: 'text', text: 'Turn 1' });
    expect(items[1]).toEqual({ type: 'text', text: 'Turn 2' });
  });

  it('skips non-text, non-toolCall content types', () => {
    const messages = [
      {
        role: 'assistant',
        content: [
          { type: 'image', source: 'data:...' },
          { type: 'text', text: 'Final' },
        ],
      },
    ];
    const items = getDisplayItems(messages);
    expect(items).toHaveLength(1);
    expect(items[0]).toEqual({ type: 'text', text: 'Final' });
  });
});

// ─── mapWithConcurrencyLimit ──────────────────────────────────────────────────

describe('mapWithConcurrencyLimit', () => {
  it('returns empty array for empty input', async () => {
    const result = await mapWithConcurrencyLimit([], 3, async (x) => x);
    expect(result).toEqual([]);
  });

  it('processes all items and returns results in original order', async () => {
    const items = [1, 2, 3, 4, 5];
    const result = await mapWithConcurrencyLimit(items, 2, async (x) => x * 2);
    expect(result).toEqual([2, 4, 6, 8, 10]);
  });

  it('passes the index to the callback', async () => {
    const items = ['a', 'b', 'c'];
    const indices: number[] = [];
    await mapWithConcurrencyLimit(items, 2, async (_item, idx) => {
      indices.push(idx);
      return idx;
    });
    expect(indices.sort()).toEqual([0, 1, 2]);
  });

  it('limits concurrency to the specified limit', async () => {
    let active = 0;
    let maxActive = 0;
    const items = Array.from({ length: 10 }, (_, i) => i);

    await mapWithConcurrencyLimit(items, 3, async (item) => {
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise((r) => setTimeout(r, 5)); // small delay to allow overlap
      active--;
      return item;
    });

    expect(maxActive).toBeLessThanOrEqual(3);
  });

  it('works when limit exceeds item count', async () => {
    const items = [10, 20];
    const result = await mapWithConcurrencyLimit(items, 100, async (x) => x + 1);
    expect(result).toEqual([11, 21]);
  });

  it('handles limit of 1 (fully sequential)', async () => {
    const order: number[] = [];
    const items = [1, 2, 3];
    await mapWithConcurrencyLimit(items, 1, async (x) => {
      order.push(x);
      return x;
    });
    expect(order).toEqual([1, 2, 3]);
  });
});

// ─── spawnAgent ───────────────────────────────────────────────────────────────

/** Polls until the mock has been called at least once, then resolves. */
async function untilCalled(mockFn: ReturnType<typeof vi.fn>, timeoutMs = 1000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (mockFn.mock.calls.length === 0) {
    if (Date.now() > deadline) throw new Error('untilCalled: timeout waiting for mock');
    await new Promise<void>((r) => setTimeout(r, 5));
  }
}

/**
 * Builds a minimal fake child process backed by EventEmitter so tests can
 * control stdout/stderr data and the close/error events without actually
 * spawning a subprocess.
 */
function makeFakeProc() {
  const stdout = new EventEmitter() as EventEmitter & { pipe?: unknown };
  const stderr = new EventEmitter() as EventEmitter & { pipe?: unknown };

  const proc = new EventEmitter() as EventEmitter & {
    stdout: typeof stdout;
    stderr: typeof stderr;
    kill: ReturnType<typeof vi.fn>;
    killed: boolean;
  };

  proc.stdout = stdout;
  proc.stderr = stderr;
  proc.kill = vi.fn();
  proc.killed = false;

  return proc;
}

describe('spawnAgent', () => {
  let fakeProc: ReturnType<typeof makeFakeProc>;

  beforeEach(() => {
    fakeProc = makeFakeProc();
    // fakeProc implements the subset of ChildProcess used by runChildProcess:
    // stdout.on('data'), stderr.on('data'), on('close'), on('error'), kill(), killed
    vi.mocked(mockSpawn).mockReturnValue(fakeProc as never);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('passes exitCode: -1 in onUpdate callbacks while the process is still running', async () => {
    const capturedUpdates: number[] = [];

    // Start spawnAgent but do NOT await — we need to interact with the process mid-flight
    const resultPromise = spawnAgent(
      '/fake/cwd',
      makeAgent(),
      'test task',
      {},
      undefined,
      (update) => capturedUpdates.push(update.exitCode),
    );

    // Wait for spawn() to be called (writeAgentPrompt is async, so spawn is called after
    // its promises resolve — we must not emit events before the listeners are registered)
    await untilCalled(vi.mocked(mockSpawn));

    // Emit a message_end line on stdout to trigger emitUpdate()
    const assistantMsg = {
      role: 'assistant',
      content: [{ type: 'text', text: 'Working...' }],
      usage: {
        input: 10,
        output: 5,
        cacheRead: 0,
        cacheWrite: 0,
        cost: { total: 0 },
        totalTokens: 15,
      },
      model: 'claude-sonnet-4-6',
      stopReason: 'tool_use',
    };
    const ndjsonLine = JSON.stringify({ type: 'message_end', message: assistantMsg }) + '\n';
    fakeProc.stdout.emit('data', Buffer.from(ndjsonLine));

    // Close the process so spawnAgent can resolve
    fakeProc.emit('close', 0);

    await resultPromise;

    // The onUpdate fired before close must have seen exitCode: -1
    expect(capturedUpdates.length).toBeGreaterThanOrEqual(1);
    expect(capturedUpdates[0]).toBe(-1);
  });

  it('returns exitCode: 0 when the process closes with code 0', async () => {
    const resultPromise = spawnAgent('/fake/cwd', makeAgent(), 'test task', {});
    await untilCalled(vi.mocked(mockSpawn));
    fakeProc.emit('close', 0);
    const result = await resultPromise;
    expect(result.exitCode).toBe(0);
  });

  it('returns exitCode: 1 when the process closes with code 1', async () => {
    const resultPromise = spawnAgent('/fake/cwd', makeAgent(), 'test task', {});
    await untilCalled(vi.mocked(mockSpawn));
    fakeProc.emit('close', 1);
    const result = await resultPromise;
    expect(result.exitCode).toBe(1);
  });
});
