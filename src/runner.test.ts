import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { FlowAgentConfig } from './types.js';

// ─── Hoisted mock state (available to vi.mock factory) ────────────────────────

const { state, mockSession, mockCreateAgentSession, mockReload } = vi.hoisted(() => {
  const s = {
    listener: null as ((event: any) => void) | null,
    events: [] as any[],
    promptError: null as Error | null,
    lastText: 'Scout found 5 auth files',
    stats: {
      tokens: { input: 100, output: 50, cacheRead: 10, cacheWrite: 5, total: 165 },
      cost: 0.0123,
      toolCalls: 3,
      userMessages: 1,
      assistantMessages: 1,
      toolResults: 3,
      totalMessages: 5,
      sessionFile: undefined as string | undefined,
      sessionId: 'test',
    },
    sessionModel: { provider: 'anthropic', id: 'claude-sonnet-4-6' } as any,
    messages: [] as any[],
  };

  const session = {
    subscribe: vi.fn((fn: any) => {
      s.listener = fn;
      return vi.fn(); // unsubscribe
    }),
    setActiveToolsByName: vi.fn(),
    prompt: vi.fn(async () => {
      if (s.promptError) throw s.promptError;
      for (const event of s.events) {
        s.listener?.(event);
      }
    }),
    steer: vi.fn(),
    abort: vi.fn(),
    dispose: vi.fn(),
    getSessionStats: vi.fn(() => s.stats),
    getLastAssistantText: vi.fn(() => s.lastText),
    get messages() {
      return s.messages;
    },
    get model() {
      return s.sessionModel;
    },
  };

  return {
    state: s,
    mockSession: session,
    mockCreateAgentSession: vi.fn(async () => ({ session, extensionsResult: {} })),
    mockReload: vi.fn().mockResolvedValue(undefined),
  };
});

// ─── Module mock ──────────────────────────────────────────────────────────────

vi.mock('@mariozechner/pi-coding-agent', () => {
  // Must use a real class for `new` to work
  class MockResourceLoader {
    opts: any;
    constructor(opts: any) {
      this.opts = opts;
    }
    async reload() {
      return mockReload();
    }
  }

  return {
    createAgentSession: mockCreateAgentSession,
    SessionManager: { inMemory: vi.fn(() => 'mock-session-manager') },
    SettingsManager: {
      create: vi.fn(() => 'mock-settings-manager'),
      inMemory: vi.fn(() => 'mock-settings-manager'),
    },
    DefaultResourceLoader: MockResourceLoader,
    readTool: { name: 'read' },
    bashTool: { name: 'bash' },
    editTool: { name: 'edit' },
    writeTool: { name: 'write' },
    grepTool: { name: 'grep' },
    findTool: { name: 'find' },
    lsTool: { name: 'ls' },
  };
});

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeAgent(overrides: Partial<FlowAgentConfig> = {}): FlowAgentConfig {
  return {
    name: 'scout',
    label: 'Scout',
    description: 'Test scout',
    model: 'anthropic/claude-sonnet-4-6',
    thinking: 'low',
    tools: ['read', 'grep', 'find', 'ls'],
    writable: false,
    limits: { max_tokens: 60000, max_steps: 80 },
    variables: [],
    writes: [],
    systemPrompt: 'You are a test scout.',
    source: 'builtin' as const,
    filePath: '/test/scout.md',
    ...overrides,
  };
}

function makeCtx(overrides: Record<string, any> = {}) {
  const parentModel = { provider: 'anthropic', id: 'claude-sonnet-4-6' };
  return {
    cwd: '/test/project',
    model: parentModel,
    modelRegistry: {
      find: vi.fn((provider: string, modelId: string) => {
        if (provider === 'anthropic' && modelId === 'claude-sonnet-4-6') return parentModel;
        if (provider === 'anthropic' && modelId === 'claude-opus-4-6') {
          return { provider: 'anthropic', id: 'claude-opus-4-6' };
        }
        return undefined;
      }),
      getAvailable: vi.fn(() => [parentModel]),
    },
    ...overrides,
  } as any;
}

function turnEndEvent() {
  return { type: 'turn_end', message: { role: 'assistant' }, toolResults: [] };
}

function toolStartEvent(toolName: string) {
  return { type: 'tool_execution_start', toolCallId: `tc-${toolName}`, toolName, args: {} };
}

function toolEndEvent(toolName: string) {
  return {
    type: 'tool_execution_end',
    toolCallId: `tc-${toolName}`,
    toolName,
    result: {},
    isError: false,
  };
}

function textDeltaEvent(delta: string, fullText: string) {
  return {
    type: 'message_update',
    assistantMessageEvent: { type: 'text_delta', delta },
    message: { role: 'assistant', content: [{ type: 'text', text: fullText }] },
  };
}

// ─── Import under test (after mock) ──────────────────────────────────────────

import { runAgent, resolveModel, resolveTools, GRACE_TURNS } from './runner.js';

// ─── Tests ────────────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
  state.listener = null;
  state.events = [];
  state.promptError = null;
  state.lastText = 'Scout found 5 auth files';
  state.messages = [];
  state.sessionModel = { provider: 'anthropic', id: 'claude-sonnet-4-6' };
  state.stats = {
    tokens: { input: 100, output: 50, cacheRead: 10, cacheWrite: 5, total: 165 },
    cost: 0.0123,
    toolCalls: 3,
    userMessages: 1,
    assistantMessages: 1,
    toolResults: 3,
    totalMessages: 5,
    sessionFile: undefined,
    sessionId: 'test',
  };
});

// ── resolveModel ──────────────────────────────────────────────────────────────

describe('resolveModel', () => {
  it('resolves exact provider/modelId match', () => {
    const registry = {
      find: vi.fn(() => ({ provider: 'anthropic', id: 'claude-sonnet-4-6' })),
      getAvailable: vi.fn(() => []),
    };
    const result = resolveModel(registry as any, 'anthropic/claude-sonnet-4-6', undefined);
    expect(result).toEqual({ provider: 'anthropic', id: 'claude-sonnet-4-6' });
    expect(registry.find).toHaveBeenCalledWith('anthropic', 'claude-sonnet-4-6');
  });

  it('falls back to parent model when not found in registry', () => {
    const registry = {
      find: vi.fn(() => undefined),
      getAvailable: vi.fn(() => []),
    };
    const parentModel = { provider: 'anthropic', id: 'claude-haiku-4-5' };
    const result = resolveModel(registry as any, 'anthropic/nonexistent', parentModel);
    expect(result).toBe(parentModel);
  });

  it('falls back to parent model for empty model string', () => {
    const registry = {
      find: vi.fn(() => undefined),
      getAvailable: vi.fn(() => []),
    };
    const parentModel = { provider: 'anthropic', id: 'claude-sonnet-4-6' };
    const result = resolveModel(registry as any, '', parentModel);
    expect(result).toBe(parentModel);
  });
});

// ── resolveTools ──────────────────────────────────────────────────────────────

describe('resolveTools', () => {
  it('maps known tool names to pi tool objects', () => {
    const tools = resolveTools(['read', 'bash', 'grep']);
    expect(tools).toHaveLength(3);
    expect(tools.map((t: any) => t.name)).toEqual(['read', 'bash', 'grep']);
  });

  it('resolves all 7 built-in tools', () => {
    const tools = resolveTools(['read', 'bash', 'edit', 'write', 'grep', 'find', 'ls']);
    expect(tools).toHaveLength(7);
  });

  it('filters out unknown tool names', () => {
    const tools = resolveTools(['read', 'unknown', 'bash']);
    expect(tools).toHaveLength(2);
    expect(tools.map((t: any) => t.name)).toEqual(['read', 'bash']);
  });

  it('returns empty array for empty input', () => {
    expect(resolveTools([])).toEqual([]);
  });
});

// ── GRACE_TURNS ───────────────────────────────────────────────────────────────

describe('GRACE_TURNS', () => {
  it('is 5', () => {
    expect(GRACE_TURNS).toBe(5);
  });
});

// ── runAgent ──────────────────────────────────────────────────────────────────

describe('runAgent', () => {
  it('returns a successful result with usage stats', async () => {
    const result = await runAgent({
      ctx: makeCtx(),
      agent: makeAgent(),
      task: 'Find all auth files',
      variableMap: {},
    });

    expect(result.agent).toBe('scout');
    expect(result.agentSource).toBe('builtin');
    expect(result.task).toBe('Find all auth files');
    expect(result.exitCode).toBe(0);
    expect(result.usage.input).toBe(100);
    expect(result.usage.output).toBe(50);
    expect(result.usage.cacheRead).toBe(10);
    expect(result.usage.cacheWrite).toBe(5);
    expect(result.usage.cost).toBeCloseTo(0.0123);
    expect(result.model).toBe('anthropic/claude-sonnet-4-6');
  });

  it('populates messages from session for text extraction', async () => {
    // session.messages is used by getFinalOutput in dispatch/rendering
    state.messages = [
      { role: 'assistant', content: [{ type: 'text', text: 'Found 3 endpoints' }] },
    ];

    const result = await runAgent({
      ctx: makeCtx(),
      agent: makeAgent(),
      task: 'Scan auth',
      variableMap: {},
    });

    expect(result.messages).toHaveLength(1);
    expect(result.exitCode).toBe(0);
  });

  it('calls createAgentSession with correct options', async () => {
    const ctx = makeCtx();
    await runAgent({
      ctx,
      agent: makeAgent({ tools: ['read', 'bash'] }),
      task: 'Do something',
      variableMap: {},
    });

    expect(mockCreateAgentSession).toHaveBeenCalledTimes(1);
    const opts = (mockCreateAgentSession as any).mock.calls[0][0];
    expect(opts.cwd).toBe('/test/project');
    expect(opts.tools).toHaveLength(2);
    expect(opts.tools.map((t: any) => t.name)).toEqual(['read', 'bash']);
    expect(opts.model).toEqual({ provider: 'anthropic', id: 'claude-sonnet-4-6' });
  });

  it('calls session.prompt with the task string', async () => {
    await runAgent({
      ctx: makeCtx(),
      agent: makeAgent(),
      task: 'Analyze the codebase',
      variableMap: {},
    });

    expect(mockSession.prompt).toHaveBeenCalledWith('Analyze the codebase');
  });

  it('sets active tools to only the declared set', async () => {
    await runAgent({
      ctx: makeCtx(),
      agent: makeAgent({ tools: ['read', 'grep'] }),
      task: 'Search',
      variableMap: {},
    });

    expect(mockSession.setActiveToolsByName).toHaveBeenCalledWith(['read', 'grep']);
  });

  it('disposes session after successful execution', async () => {
    await runAgent({
      ctx: makeCtx(),
      agent: makeAgent(),
      task: 'Work',
      variableMap: {},
    });

    expect(mockSession.dispose).toHaveBeenCalledTimes(1);
  });

  it('returns error result when session.prompt throws', async () => {
    state.promptError = new Error('API rate limited');

    const result = await runAgent({
      ctx: makeCtx(),
      agent: makeAgent(),
      task: 'Fail task',
      variableMap: {},
    });

    expect(result.exitCode).toBe(1);
    expect(result.errorMessage).toBe('API rate limited');
    expect(result.stopReason).toBe('error');
  });

  it('disposes session after error', async () => {
    state.promptError = new Error('Crash');

    await runAgent({
      ctx: makeCtx(),
      agent: makeAgent(),
      task: 'Fail',
      variableMap: {},
    });

    expect(mockSession.dispose).toHaveBeenCalledTimes(1);
  });

  it('resolves model from agent config via registry', async () => {
    const ctx = makeCtx();
    await runAgent({
      ctx,
      agent: makeAgent({ model: 'anthropic/claude-opus-4-6' }),
      task: 'Think hard',
      variableMap: {},
    });

    expect(ctx.modelRegistry.find).toHaveBeenCalledWith('anthropic', 'claude-opus-4-6');
    const opts = (mockCreateAgentSession as any).mock.calls[0][0];
    expect(opts.model).toEqual({ provider: 'anthropic', id: 'claude-opus-4-6' });
  });

  it('falls back to parent model when agent model not found', async () => {
    const ctx = makeCtx();
    await runAgent({
      ctx,
      agent: makeAgent({ model: 'openai/gpt-nonexistent' }),
      task: 'Try anyway',
      variableMap: {},
    });

    const opts = (mockCreateAgentSession as any).mock.calls[0][0];
    expect(opts.model).toEqual({ provider: 'anthropic', id: 'claude-sonnet-4-6' });
  });

  it('injects variables into system prompt', async () => {
    await runAgent({
      ctx: makeCtx(),
      agent: makeAgent({
        systemPrompt: 'Feature: {{FEATURE_NAME}}. Patterns: {{MEMORY_PATTERNS}}',
        variables: ['FEATURE_NAME', 'MEMORY_PATTERNS'],
      }),
      task: 'Go',
      variableMap: { FEATURE_NAME: 'auth-refresh', MEMORY_PATTERNS: 'singleton used 3x' },
    });

    // The DefaultResourceLoader receives a systemPromptOverride function.
    // Verify that createAgentSession was called (loader was passed to it).
    // The systemPromptOverride is on the loader instance — verify via
    // the createAgentSession call's resourceLoader arg.
    const opts = (mockCreateAgentSession as any).mock.calls[0][0];
    const loader = opts.resourceLoader;
    const injectedPrompt = loader.opts.systemPromptOverride();
    expect(injectedPrompt).toContain('Feature: auth-refresh');
    expect(injectedPrompt).toContain('Patterns: singleton used 3x');
  });

  it('forwards abort signal to session.abort', async () => {
    const controller = new AbortController();

    // Pre-abort before calling runAgent — abort handler wires synchronously
    // and calls session.abort() immediately if signal is already aborted
    controller.abort();

    await runAgent({
      ctx: makeCtx(),
      agent: makeAgent(),
      task: 'Long task',
      variableMap: {},
      signal: controller.signal,
    });

    expect(mockSession.abort).toHaveBeenCalled();
  });

  // ── Callbacks ─────────────────────────────────────────────────────────────

  it('calls onTurnEnd callback with turn count', async () => {
    state.events = [turnEndEvent(), turnEndEvent(), turnEndEvent()];
    const onTurnEnd = vi.fn();

    await runAgent({
      ctx: makeCtx(),
      agent: makeAgent(),
      task: 'Multi-turn',
      variableMap: {},
      callbacks: { onTurnEnd },
    });

    expect(onTurnEnd).toHaveBeenCalledTimes(3);
    expect(onTurnEnd).toHaveBeenNthCalledWith(1, 1);
    expect(onTurnEnd).toHaveBeenNthCalledWith(2, 2);
    expect(onTurnEnd).toHaveBeenNthCalledWith(3, 3);
  });

  it('calls onToolActivity callback for tool events', async () => {
    state.events = [
      toolStartEvent('read'),
      toolEndEvent('read'),
      toolStartEvent('grep'),
      toolEndEvent('grep'),
    ];
    const onToolActivity = vi.fn();

    await runAgent({
      ctx: makeCtx(),
      agent: makeAgent(),
      task: 'Tool work',
      variableMap: {},
      callbacks: { onToolActivity },
    });

    expect(onToolActivity).toHaveBeenCalledTimes(4);
    expect(onToolActivity).toHaveBeenNthCalledWith(1, { type: 'start', toolName: 'read' });
    expect(onToolActivity).toHaveBeenNthCalledWith(2, { type: 'end', toolName: 'read' });
  });

  it('calls onTextDelta callback for text updates', async () => {
    state.events = [textDeltaEvent('Hello', 'Hello'), textDeltaEvent(' world', 'Hello world')];
    const onTextDelta = vi.fn();

    await runAgent({
      ctx: makeCtx(),
      agent: makeAgent(),
      task: 'Streaming',
      variableMap: {},
      callbacks: { onTextDelta },
    });

    expect(onTextDelta).toHaveBeenCalledTimes(2);
    expect(onTextDelta).toHaveBeenNthCalledWith(1, 'Hello', 'Hello');
    expect(onTextDelta).toHaveBeenNthCalledWith(2, ' world', 'Hello world');
  });

  // ── Graceful turn limits ──────────────────────────────────────────────────

  it('steers agent when turn count reaches max_steps', async () => {
    // 3 turns, max_steps = 3 → steer after turn 3
    state.events = [turnEndEvent(), turnEndEvent(), turnEndEvent()];

    await runAgent({
      ctx: makeCtx(),
      agent: makeAgent({ limits: { max_tokens: 60000, max_steps: 3 } }),
      task: 'Bounded task',
      variableMap: {},
    });

    expect(mockSession.steer).toHaveBeenCalledTimes(1);
    expect(mockSession.steer.mock.calls[0][0]).toContain('turn limit');
  });

  it('aborts agent when turns exceed max_steps + grace', async () => {
    // max_steps = 2, grace = 5, so abort at turn 7 (2 + 5)
    // Events beyond that also trigger abort (idempotent)
    const events = Array.from({ length: 8 }, () => turnEndEvent());
    state.events = events;

    await runAgent({
      ctx: makeCtx(),
      agent: makeAgent({ limits: { max_tokens: 60000, max_steps: 2 } }),
      task: 'Runaway task',
      variableMap: {},
    });

    expect(mockSession.steer).toHaveBeenCalledTimes(1); // at turn 2
    expect(mockSession.abort).toHaveBeenCalled(); // at turn 7+
  });

  it('does not steer when max_steps is 0 (unlimited)', async () => {
    state.events = Array.from({ length: 20 }, () => turnEndEvent());

    await runAgent({
      ctx: makeCtx(),
      agent: makeAgent({ limits: { max_tokens: 60000, max_steps: 0 } }),
      task: 'Unlimited',
      variableMap: {},
    });

    expect(mockSession.steer).not.toHaveBeenCalled();
    expect(mockSession.abort).not.toHaveBeenCalled();
  });

  it('marks result as steered when turn limit was hit', async () => {
    state.events = [turnEndEvent(), turnEndEvent(), turnEndEvent()];

    const result = await runAgent({
      ctx: makeCtx(),
      agent: makeAgent({ limits: { max_tokens: 60000, max_steps: 3 } }),
      task: 'Bounded',
      variableMap: {},
    });

    expect(result.stopReason).toBe('steered');
  });

  it('includes startedAt timestamp in result', async () => {
    const before = Date.now();
    const result = await runAgent({
      ctx: makeCtx(),
      agent: makeAgent(),
      task: 'Timed',
      variableMap: {},
    });
    const after = Date.now();

    expect(result.startedAt).toBeGreaterThanOrEqual(before);
    expect(result.startedAt).toBeLessThanOrEqual(after);
  });
});
