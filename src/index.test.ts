import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Module mocks (must be declared before any imports) ───────────────────────

vi.mock('./agents.js', () => ({
  discoverAgents: vi.fn(() => []),
  buildVariableMap: vi.fn(() => ({})),
}));

vi.mock('./prompt.js', () => ({
  buildCoordinatorPrompt: vi.fn(() => '## Coordinator\n\nCoordinator prompt here'),
  buildNudgeMessage: vi.fn(() => 'Continue your workflow: my-feature at execute'),
}));

vi.mock('./dispatch.js', () => ({
  executeDispatch: vi.fn(async () => ({
    isError: false,
    content: [{ type: 'text', text: 'done' }],
  })),
}));

vi.mock('./state.js', () => ({
  findFlowDir: vi.fn(() => null),
  readStateFile: vi.fn(() => null),
  writeCheckpoint: vi.fn(),
  writeDispatchLog: vi.fn(),
  appendProgressLog: vi.fn(),
}));

vi.mock('./rendering.js', () => ({
  renderSingleCall: vi.fn(() => ''),
  renderParallelCall: vi.fn(() => ''),
  renderChainCall: vi.fn(() => ''),
  renderSingleResult: vi.fn(() => ''),
  renderParallelResult: vi.fn(() => ''),
  renderChainResult: vi.fn(() => ''),
  renderFlowStatus: vi.fn(() => ''),
  formatToolCall: vi.fn(() => ''),
}));

vi.mock('./guardrails.js', () => ({
  hashToolCall: vi.fn(() => 'abc123'),
  detectLoop: vi.fn(() => ({ tripped: false })),
}));

vi.mock('./memory.js', () => ({
  writeBackMemory: vi.fn(),
}));

vi.mock('./spawn.js', () => ({
  aggregateUsage: vi.fn(() => ({ turns: 0, input: 0, output: 0, cost: 0 })),
  getFinalOutput: vi.fn(() => null),
  getDisplayItems: vi.fn(() => []),
  mapWithConcurrencyLimit: vi.fn(),
  spawnAgentWithRetry: vi.fn(),
}));

vi.mock('@mariozechner/pi-coding-agent', () => ({
  getMarkdownTheme: vi.fn(() => ({})),
}));

vi.mock('@mariozechner/pi-tui', () => ({
  Container: class MockContainer {
    addChild = vi.fn();
    render = vi.fn(() => '');
  },
  Markdown: class MockMarkdown {},
  Spacer: class MockSpacer {},
  Text: class MockText {
    constructor(
      public text: string,
      _x: number,
      _y: number,
    ) {}
  },
}));

vi.mock('@sinclair/typebox', () => ({
  Type: {
    Object: vi.fn((obj: unknown) => obj),
    String: vi.fn((opts?: unknown) => opts ?? {}),
    Optional: vi.fn((schema: unknown) => schema),
    Array: vi.fn((schema: unknown, _opts?: unknown) => schema),
    Number: vi.fn((opts?: unknown) => opts ?? {}),
  },
}));

vi.mock('node:fs', async (importActual) => {
  const actual = await importActual<typeof import('node:fs')>();
  return {
    ...actual,
    existsSync: vi.fn(actual.existsSync),
    readdirSync: vi.fn(actual.readdirSync),
    statSync: vi.fn(actual.statSync),
    readFileSync: vi.fn(actual.readFileSync),
    rmSync: vi.fn(actual.rmSync),
    mkdirSync: vi.fn(actual.mkdirSync),
    writeFileSync: vi.fn(actual.writeFileSync),
  };
});

// ─── Imports (after mocks) ────────────────────────────────────────────────────

import { discoverAgents } from './agents.js';
import { buildCoordinatorPrompt, buildNudgeMessage } from './prompt.js';
import { findFlowDir, readStateFile } from './state.js';
import piFlow from './index.js';
import type { ExtensionAPI } from '@mariozechner/pi-coding-agent';
import * as fs from 'node:fs';

// ─── Test helpers ─────────────────────────────────────────────────────────────

function makeFlowState(overrides: Record<string, unknown> = {}) {
  return {
    feature: 'my-feature',
    change_type: 'feature',
    current_phase: 'execute',
    current_wave: 1,
    wave_count: 3,
    skipped_phases: [],
    gates: { spec_approved: false, design_approved: false, review_verdict: null },
    sentinel: { open_halts: 0, open_warns: 0 },
    budget: { total_tokens: 0, total_cost_usd: 0 },
    ...overrides,
  };
}

/**
 * Build a minimal pi mock that captures hook registrations and provides
 * enough surface area for the extension to operate.
 */
function makePiMock() {
  const hooks: Record<string, ((...args: unknown[]) => unknown)[]> = {};
  const pi = {
    registerTool: vi.fn(),
    registerCommand: vi.fn(),
    on: vi.fn((event: string, handler: (...args: unknown[]) => unknown) => {
      if (!hooks[event]) hooks[event] = [];
      hooks[event].push(handler);
    }),
    sendMessage: vi.fn(),
    // Helper to trigger a hook by name
    async trigger(event: string, eventArg: unknown = {}, ctx: unknown = {}) {
      const handlers = hooks[event] ?? [];
      let result: unknown;
      for (const h of handlers) {
        result = await h(eventArg, ctx);
      }
      return result;
    },
    hooks,
  };
  return pi as unknown as ExtensionAPI & {
    hooks: Record<string, ((...args: unknown[]) => unknown)[]>;
    trigger: (event: string, eventArg?: unknown, ctx?: unknown) => Promise<unknown>;
  };
}

function makeCtx(cwd = '/project') {
  return {
    cwd,
    hasUI: false,
    ui: { notify: vi.fn(), setStatus: vi.fn(), confirm: vi.fn() },
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('piFlow hook registration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(findFlowDir).mockReturnValue(null);
  });

  it('registers an input hook', () => {
    const pi = makePiMock();
    piFlow(pi);
    const registeredEvents = (pi.on as ReturnType<typeof vi.fn>).mock.calls.map(
      (c: unknown[]) => c[0],
    );
    expect(registeredEvents).toContain('input');
  });

  it('registers a before_agent_start hook', () => {
    const pi = makePiMock();
    piFlow(pi);
    const registeredEvents = (pi.on as ReturnType<typeof vi.fn>).mock.calls.map(
      (c: unknown[]) => c[0],
    );
    expect(registeredEvents).toContain('before_agent_start');
  });

  it('registers an agent_end hook', () => {
    const pi = makePiMock();
    piFlow(pi);
    const registeredEvents = (pi.on as ReturnType<typeof vi.fn>).mock.calls.map(
      (c: unknown[]) => c[0],
    );
    expect(registeredEvents).toContain('agent_end');
  });
});

describe('input hook', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(findFlowDir).mockReturnValue(null);
  });

  it('resets nudgedThisCycle to false when triggered', async () => {
    const pi = makePiMock();
    piFlow(pi);

    // Simulate a cycle: agent_end sets nudgedThisCycle = true (if feature is active)
    // Then input should reset it.
    // We verify by running two agent_end calls:
    // first one triggers a nudge (active feature, execute phase)
    // second one should NOT trigger (nudgedThisCycle is still true)
    // then after input hook fires, third agent_end triggers again.

    // Set up a fake active feature
    vi.mocked(findFlowDir).mockReturnValue('/project/.flow');
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readdirSync).mockReturnValue(['my-feature'] as any);
    vi.mocked(fs.statSync).mockReturnValue({ isDirectory: () => true } as any);
    vi.mocked(readStateFile).mockReturnValue(makeFlowState() as any);

    const ctx = makeCtx();

    // First agent_end — should nudge
    await pi.trigger('agent_end', {}, ctx);
    expect(pi.sendMessage).toHaveBeenCalledTimes(1);

    // Second agent_end — nudgedThisCycle is true, should NOT nudge again
    await pi.trigger('agent_end', {}, ctx);
    expect(pi.sendMessage).toHaveBeenCalledTimes(1);

    // Fire input hook — resets the guard
    await pi.trigger('input', {}, ctx);

    // Third agent_end — guard reset, should nudge again
    await pi.trigger('agent_end', {}, ctx);
    expect(pi.sendMessage).toHaveBeenCalledTimes(2);
  });
});

describe('before_agent_start hook', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(findFlowDir).mockReturnValue(null);
  });

  it('returns extended systemPrompt with coordinator prompt appended', async () => {
    const pi = makePiMock();
    piFlow(pi);

    vi.mocked(discoverAgents).mockReturnValue([]);
    vi.mocked(buildCoordinatorPrompt).mockReturnValue('## Coordinator\n\nHello');

    const result = await pi.trigger(
      'before_agent_start',
      { systemPrompt: 'Base prompt' },
      makeCtx(),
    );

    expect(result).toEqual({
      systemPrompt: 'Base prompt\n\n## Coordinator\n\nHello',
    });
  });

  it('calls discoverAgents with rootDir (not extensionDir)', async () => {
    const pi = makePiMock();
    piFlow(pi);

    vi.mocked(discoverAgents).mockReturnValue([]);

    const ctx = makeCtx('/my/project');
    await pi.trigger('before_agent_start', { systemPrompt: '' }, ctx);

    expect(discoverAgents).toHaveBeenCalledTimes(1);
    const [rootDirArg, cwdArg] = vi.mocked(discoverAgents).mock.calls[0];

    // rootDir must NOT end with /src — it's one level above extensionDir
    expect(rootDirArg).not.toMatch(/\/src$/);
    // cwd must be the ctx.cwd
    expect(cwdArg).toBe('/my/project');
  });

  it('calls buildCoordinatorPrompt with discovered agents and active feature', async () => {
    const pi = makePiMock();
    piFlow(pi);

    const fakeAgents = [{ name: 'builder' }] as any;
    vi.mocked(discoverAgents).mockReturnValue(fakeAgents);

    // With no active feature (findFlowDir returns null)
    await pi.trigger('before_agent_start', { systemPrompt: '' }, makeCtx());

    expect(buildCoordinatorPrompt).toHaveBeenCalledWith(fakeAgents, null);
  });

  it('returns static fallback systemPrompt when an error is thrown', async () => {
    const pi = makePiMock();
    piFlow(pi);

    vi.mocked(discoverAgents).mockImplementation(() => {
      throw new Error('agents directory not found');
    });

    const result = await pi.trigger('before_agent_start', { systemPrompt: 'Base' }, makeCtx());

    expect((result as any).systemPrompt).toContain('Base');
    expect((result as any).systemPrompt).toContain('dispatch_flow');
    expect((result as any).systemPrompt).toContain('## Coordinator');
  });
});

describe('agent_end hook', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    vi.mocked(findFlowDir).mockReturnValue(null);
    // Reset the module-level nudgedThisCycle guard by firing the input hook.
    const tempPi = makePiMock();
    piFlow(tempPi);
    await tempPi.trigger('input', {}, makeCtx());
  });

  it('does nothing when there is no active feature', async () => {
    const pi = makePiMock();
    piFlow(pi);

    // findFlowDir returns null → findActiveFeature returns null
    await pi.trigger('agent_end', {}, makeCtx());

    expect(pi.sendMessage).not.toHaveBeenCalled();
  });

  it('does nothing when current_phase is ship', async () => {
    const pi = makePiMock();
    piFlow(pi);

    vi.mocked(findFlowDir).mockReturnValue('/project/.flow');
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readdirSync).mockReturnValue(['my-feature'] as any);
    vi.mocked(fs.statSync).mockReturnValue({ isDirectory: () => true } as any);
    vi.mocked(readStateFile).mockReturnValue(makeFlowState({ current_phase: 'ship' }) as any);

    await pi.trigger('agent_end', {}, makeCtx());

    expect(pi.sendMessage).not.toHaveBeenCalled();
  });

  it('sends a nudge message when feature is active and phase is not ship', async () => {
    const pi = makePiMock();
    piFlow(pi);

    vi.mocked(findFlowDir).mockReturnValue('/project/.flow');
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readdirSync).mockReturnValue(['my-feature'] as any);
    vi.mocked(fs.statSync).mockReturnValue({ isDirectory: () => true } as any);
    const state = makeFlowState({ current_phase: 'execute' });
    vi.mocked(readStateFile).mockReturnValue(state as any);
    vi.mocked(buildNudgeMessage).mockReturnValue('Keep going!');

    await pi.trigger('agent_end', {}, makeCtx());

    expect(pi.sendMessage).toHaveBeenCalledTimes(1);
    const [msgArg, optsArg] = vi.mocked(pi.sendMessage).mock.calls[0];
    expect(msgArg.content).toBe('Keep going!');
    expect(msgArg.customType).toBe('pi-flow-nudge');
    expect(msgArg.display).toBe(true);
    expect(optsArg).toEqual({ triggerTurn: true });
  });

  it('does not send a second nudge when nudgedThisCycle is already true', async () => {
    const pi = makePiMock();
    piFlow(pi);

    vi.mocked(findFlowDir).mockReturnValue('/project/.flow');
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readdirSync).mockReturnValue(['my-feature'] as any);
    vi.mocked(fs.statSync).mockReturnValue({ isDirectory: () => true } as any);
    vi.mocked(readStateFile).mockReturnValue(makeFlowState() as any);

    // First call — should nudge
    await pi.trigger('agent_end', {}, makeCtx());
    expect(pi.sendMessage).toHaveBeenCalledTimes(1);

    // Second call in same cycle — guard prevents nudge
    await pi.trigger('agent_end', {}, makeCtx());
    expect(pi.sendMessage).toHaveBeenCalledTimes(1);
  });

  it('passes state to buildNudgeMessage', async () => {
    const pi = makePiMock();
    piFlow(pi);

    vi.mocked(findFlowDir).mockReturnValue('/project/.flow');
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readdirSync).mockReturnValue(['feature-x'] as any);
    vi.mocked(fs.statSync).mockReturnValue({ isDirectory: () => true } as any);
    const state = makeFlowState({ feature: 'feature-x', current_phase: 'review' });
    vi.mocked(readStateFile).mockReturnValue(state as any);

    await pi.trigger('agent_end', {}, makeCtx());

    expect(buildNudgeMessage).toHaveBeenCalledWith(state);
  });
});
