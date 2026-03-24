import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as path from 'node:path';
import type { FlowAgentConfig, FlowConfig, FlowState, Phase, SingleAgentResult } from './types.js';

// ─── module mocks ─────────────────────────────────────────────────────────────

// Partially mock spawn.js — keep getFinalOutput and mapWithConcurrencyLimit real
vi.mock('./spawn.js', async (importActual) => {
  const actual = await importActual<typeof import('./spawn.js')>();
  return {
    ...actual,
    spawnAgentWithRetry: vi.fn(),
  };
});

vi.mock('./agents.js', () => ({
  discoverAgents: vi.fn(),
  buildVariableMap: vi.fn(),
}));

vi.mock('./config.js', () => ({
  loadConfig: vi.fn(),
}));

vi.mock('./state.js', () => ({
  readStateFile: vi.fn(),
  writeDispatchLog: vi.fn(),
  appendProgressLog: vi.fn(),
  writeStateFile: vi.fn(),
  ensureFeatureDir: vi.fn(),
}));

// ─── imports (after mocks) ────────────────────────────────────────────────────

import {
  findAgent,
  validateAgentPhase,
  makeDetails,
  executeDispatch,
  type DispatchParams,
  type DispatchResult,
} from './dispatch.js';
import { spawnAgentWithRetry } from './spawn.js';
import { discoverAgents, buildVariableMap } from './agents.js';
import { loadConfig } from './config.js';
import { writeDispatchLog, writeStateFile, ensureFeatureDir, appendProgressLog, readStateFile } from './state.js';

// ─── test helpers ─────────────────────────────────────────────────────────────

function makeAgent(overrides: Partial<FlowAgentConfig> = {}): FlowAgentConfig {
  return {
    name: 'builder',
    label: 'Builder',
    description: 'Builds things',
    model: 'claude-sonnet-4-6',
    thinking: 'medium',
    tools: ['read', 'write', 'edit', 'bash'],
    phases: ['execute'],
    writable: true,
    temperament: 'disciplined',
    limits: { max_tokens: 100000, max_steps: 120 },
    variables: [],
    systemPrompt: 'You are builder.',
    source: 'builtin',
    filePath: '/agents/builder.md',
    ...overrides,
  };
}

function makeResult(overrides: Partial<SingleAgentResult> = {}): SingleAgentResult {
  return {
    agent: 'builder',
    agentSource: 'builtin',
    task: 'implement feature',
    exitCode: 0,
    messages: [
      {
        role: 'assistant',
        content: [{ type: 'text', text: 'Task complete.' }],
      },
    ],
    stderr: '',
    usage: {
      input: 100,
      output: 50,
      cacheRead: 0,
      cacheWrite: 0,
      cost: 0.001,
      contextTokens: 150,
      turns: 1,
    },
    ...overrides,
  };
}

function makeConfig(): FlowConfig {
  return {
    concurrency: { max_parallel: 4, max_workers: 4, stagger_ms: 150 },
    guardrails: {
      token_cap_per_agent: 100000,
      cost_cap_per_agent_usd: 10.0,
      scope_creep_warning: 0.2,
      scope_creep_halt: 0.3,
      loop_detection_window: 10,
      loop_detection_threshold: 3,
      analysis_paralysis_threshold: 8,
      git_watchdog_warn_minutes: 15,
      git_watchdog_halt_minutes: 30,
    },
    memory: { enabled: true },
    git: { branch_prefix: 'feature/', commit_style: 'conventional', auto_pr: true },
  };
}

function makeFlowState(overrides: Partial<FlowState> = {}): FlowState {
  return {
    feature: 'auth',
    change_type: 'feature',
    current_phase: 'execute',
    current_wave: null,
    wave_count: null,
    skipped_phases: [],
    started_at: '2026-01-01T00:00:00.000Z',
    last_updated: '2026-01-01T00:00:00.000Z',
    budget: { total_tokens: 0, total_cost_usd: 0 },
    gates: { spec_approved: false, design_approved: false, review_verdict: null },
    sentinel: { open_halts: 0, open_warns: 0 },
    ...overrides,
  };
}

const CWD = '/tmp/test-project';
const EXTENSION_DIR = '/tmp/extension';

// ─── findAgent ────────────────────────────────────────────────────────────────

describe('findAgent', () => {
  it('returns the agent matching the given name', () => {
    const builder = makeAgent({ name: 'builder' });
    const scout = makeAgent({ name: 'scout' });
    const result = findAgent([builder, scout], 'scout');
    expect(result).toBe(scout);
  });

  it('returns null when no agent matches the name', () => {
    const builder = makeAgent({ name: 'builder' });
    const result = findAgent([builder], 'sentinel');
    expect(result).toBeNull();
  });

  it('returns null from an empty list', () => {
    const result = findAgent([], 'builder');
    expect(result).toBeNull();
  });

  it('returns the first matching agent when duplicates exist', () => {
    const first = makeAgent({ name: 'builder', description: 'first' });
    const second = makeAgent({ name: 'builder', description: 'second' });
    const result = findAgent([first, second], 'builder');
    expect(result?.description).toBe('first');
  });
});

// ─── validateAgentPhase ───────────────────────────────────────────────────────

describe('validateAgentPhase', () => {
  it('returns allowed=true when the phase is in the agents phases list', () => {
    const agent = makeAgent({ phases: ['execute', 'review'] });
    const result = validateAgentPhase(agent, 'execute');
    expect(result.allowed).toBe(true);
    expect(result.reason).toMatch(/allowed/i);
  });

  it('returns allowed=false when the phase is not in the agents phases list', () => {
    const agent = makeAgent({ name: 'clarifier', phases: ['intent', 'spec'] });
    const result = validateAgentPhase(agent, 'execute');
    expect(result.allowed).toBe(false);
  });

  it('includes the agent name in the reason when not allowed', () => {
    const agent = makeAgent({ name: 'clarifier', phases: ['intent'] });
    const result = validateAgentPhase(agent, 'execute');
    expect(result.reason).toContain('clarifier');
  });

  it('includes the phase in the reason when not allowed', () => {
    const agent = makeAgent({ name: 'planner', phases: ['plan'] });
    const result = validateAgentPhase(agent, 'ship');
    expect(result.reason).toContain('ship');
  });

  it('returns allowed=true when phases includes only that phase', () => {
    const agent = makeAgent({ phases: ['spec'] });
    const result = validateAgentPhase(agent, 'spec');
    expect(result.allowed).toBe(true);
  });
});

// ─── makeDetails ─────────────────────────────────────────────────────────────

describe('makeDetails', () => {
  it('creates a factory that sets mode, phase, and feature on the details', () => {
    const factory = makeDetails('single', 'execute', 'my-feature');
    const details = factory([]);
    expect(details.mode).toBe('single');
    expect(details.phase).toBe('execute');
    expect(details.feature).toBe('my-feature');
  });

  it('factory populates results from the given array', () => {
    const r1 = makeResult({ agent: 'builder' });
    const r2 = makeResult({ agent: 'scout' });
    const factory = makeDetails('parallel', 'analyze', 'feat');
    const details = factory([r1, r2]);
    expect(details.results).toHaveLength(2);
    expect(details.results[0].agent).toBe('builder');
    expect(details.results[1].agent).toBe('scout');
  });

  it('works with all three modes', () => {
    for (const mode of ['single', 'parallel', 'chain'] as const) {
      const factory = makeDetails(mode, 'intent', 'x');
      const details = factory([]);
      expect(details.mode).toBe(mode);
    }
  });

  it('produces independent details for different results arrays', () => {
    const factory = makeDetails('chain', 'execute', 'feat');
    const r1 = makeResult({ agent: 'scout' });
    const r2 = makeResult({ agent: 'builder' });
    const d1 = factory([r1]);
    const d2 = factory([r1, r2]);
    expect(d1.results).toHaveLength(1);
    expect(d2.results).toHaveLength(2);
  });
});

// ─── executeDispatch — shared setup ──────────────────────────────────────────

describe('executeDispatch', () => {
  const builder = makeAgent({ name: 'builder', phases: ['execute'] });
  const scout = makeAgent({ name: 'scout', phases: ['analyze', 'execute'] });

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(loadConfig).mockReturnValue(makeConfig());
    vi.mocked(discoverAgents).mockReturnValue([builder, scout]);
    vi.mocked(buildVariableMap).mockReturnValue({ FEATURE_NAME: 'my-feature' });
    vi.mocked(writeDispatchLog).mockReturnValue(undefined);
  });

  // ─── routing ────────────────────────────────────────────────────────────

  describe('routing', () => {
    it('routes to single mode when agent and task are provided', async () => {
      vi.mocked(spawnAgentWithRetry).mockResolvedValue(makeResult());

      const params: DispatchParams = {
        agent: 'builder',
        task: 'implement auth',
        phase: 'execute',
        feature: 'auth',
      };

      const result = await executeDispatch(params, CWD, EXTENSION_DIR);
      expect(result.details.mode).toBe('single');
      expect(spawnAgentWithRetry).toHaveBeenCalledTimes(1);
    });

    it('routes to parallel mode when parallel array is provided', async () => {
      const r1 = makeResult({ agent: 'builder' });
      const r2 = makeResult({ agent: 'scout' });
      vi.mocked(spawnAgentWithRetry)
        .mockResolvedValueOnce(r1)
        .mockResolvedValueOnce(r2);

      const params: DispatchParams = {
        parallel: [
          { agent: 'builder', task: 'task 1' },
          { agent: 'scout', task: 'task 2' },
        ],
        phase: 'execute',
        feature: 'auth',
      };

      const result = await executeDispatch(params, CWD, EXTENSION_DIR);
      expect(result.details.mode).toBe('parallel');
      expect(spawnAgentWithRetry).toHaveBeenCalledTimes(2);
    });

    it('routes to chain mode when chain array is provided', async () => {
      const r1 = makeResult({ agent: 'scout' });
      const r2 = makeResult({ agent: 'builder' });
      vi.mocked(spawnAgentWithRetry)
        .mockResolvedValueOnce(r1)
        .mockResolvedValueOnce(r2);

      const params: DispatchParams = {
        chain: [
          { agent: 'scout', task: 'analyze' },
          { agent: 'builder', task: 'implement' },
        ],
        phase: 'execute',
        feature: 'auth',
      };

      const result = await executeDispatch(params, CWD, EXTENSION_DIR);
      expect(result.details.mode).toBe('chain');
      expect(spawnAgentWithRetry).toHaveBeenCalledTimes(2);
    });
  });

  // ─── error cases ────────────────────────────────────────────────────────

  describe('error handling', () => {
    it('returns isError=true when single-mode agent is not found', async () => {
      const params: DispatchParams = {
        agent: 'nonexistent',
        task: 'do something',
        phase: 'execute',
        feature: 'auth',
      };

      const result = await executeDispatch(params, CWD, EXTENSION_DIR);
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toMatch(/nonexistent/i);
    });

    it('returns isError=true when agent not found in parallel mode', async () => {
      const params: DispatchParams = {
        parallel: [
          { agent: 'builder', task: 'task 1' },
          { agent: 'ghost', task: 'task 2' },
        ],
        phase: 'execute',
        feature: 'auth',
      };

      const result = await executeDispatch(params, CWD, EXTENSION_DIR);
      expect(result.isError).toBe(true);
    });

    it('returns isError=true when agent is not allowed in the current phase', async () => {
      // builder is only in ['execute'] — try calling it during 'spec'
      const params: DispatchParams = {
        agent: 'builder',
        task: 'do something',
        phase: 'spec',
        feature: 'auth',
      };

      const result = await executeDispatch(params, CWD, EXTENSION_DIR);
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toMatch(/phase/i);
    });

    it('returns isError=true when neither agent+task, parallel, nor chain is provided', async () => {
      const params: DispatchParams = {
        phase: 'execute',
        feature: 'auth',
      };

      const result = await executeDispatch(params, CWD, EXTENSION_DIR);
      expect(result.isError).toBe(true);
    });

    it('returns isError=true when agent not found in chain mode', async () => {
      const params: DispatchParams = {
        chain: [
          { agent: 'builder', task: 'task 1' },
          { agent: 'ghost', task: 'task 2' },
        ],
        phase: 'execute',
        feature: 'auth',
      };

      const result = await executeDispatch(params, CWD, EXTENSION_DIR);
      expect(result.isError).toBe(true);
    });
  });

  // ─── single mode behavior ────────────────────────────────────────────────

  describe('single mode', () => {
    it('calls spawnAgentWithRetry with correct cwd and agent', async () => {
      const agentResult = makeResult();
      vi.mocked(spawnAgentWithRetry).mockResolvedValue(agentResult);

      const params: DispatchParams = {
        agent: 'builder',
        task: 'implement auth module',
        phase: 'execute',
        feature: 'auth',
      };

      await executeDispatch(params, CWD, EXTENSION_DIR);

      // Check the first 5 positional args; the 6th (callback) is optional
      const call = vi.mocked(spawnAgentWithRetry).mock.calls[0];
      expect(call[0]).toBe(CWD);
      expect(call[1]).toBe(builder);
      expect(call[2]).toBe('implement auth module');
      expect(call[3]).toEqual(expect.any(Object)); // variableMap
      expect(call[4]).toBeUndefined();             // signal
    });

    it('passes the variable map to spawnAgentWithRetry', async () => {
      const variableMap = { FEATURE_NAME: 'auth', SPEC_GOAL: 'secure tokens' };
      vi.mocked(buildVariableMap).mockReturnValue(variableMap);
      vi.mocked(spawnAgentWithRetry).mockResolvedValue(makeResult());

      const params: DispatchParams = {
        agent: 'builder',
        task: 'do work',
        phase: 'execute',
        feature: 'auth',
      };

      await executeDispatch(params, CWD, EXTENSION_DIR);

      // Check the first 5 positional args; the 6th (callback) is optional
      const call = vi.mocked(spawnAgentWithRetry).mock.calls[0];
      expect(call[0]).toBe(CWD);
      expect(call[1]).toBe(builder);
      expect(call[2]).toBe('do work');
      expect(call[3]).toEqual(variableMap);
      expect(call[4]).toBeUndefined();
    });

    it('writes dispatch log after agent completes', async () => {
      vi.mocked(spawnAgentWithRetry).mockResolvedValue(makeResult());

      const params: DispatchParams = {
        agent: 'builder',
        task: 'do work',
        phase: 'execute',
        feature: 'auth',
      };

      await executeDispatch(params, CWD, EXTENSION_DIR);

      expect(writeDispatchLog).toHaveBeenCalledTimes(1);
      expect(writeDispatchLog).toHaveBeenCalledWith(
        expect.stringContaining('.flow'),
        'auth',
        expect.objectContaining({ agent: 'builder' }),
      );
    });

    it('returns content with the agents final output', async () => {
      const agentResult = makeResult({
        messages: [
          { role: 'assistant', content: [{ type: 'text', text: 'Auth module complete.' }] },
        ],
      });
      vi.mocked(spawnAgentWithRetry).mockResolvedValue(agentResult);

      const params: DispatchParams = {
        agent: 'builder',
        task: 'implement auth',
        phase: 'execute',
        feature: 'auth',
      };

      const result = await executeDispatch(params, CWD, EXTENSION_DIR);
      expect(result.content[0].type).toBe('text');
      expect(result.content[0].text).toBe('Auth module complete.');
    });

    it('includes the result in details.results', async () => {
      const agentResult = makeResult({ agent: 'builder' });
      vi.mocked(spawnAgentWithRetry).mockResolvedValue(agentResult);

      const params: DispatchParams = {
        agent: 'builder',
        task: 'do work',
        phase: 'execute',
        feature: 'auth',
      };

      const result = await executeDispatch(params, CWD, EXTENSION_DIR);
      expect(result.details.results).toHaveLength(1);
      expect(result.details.results[0].agent).toBe('builder');
    });

    it('calls onUpdate when agent emits progress', async () => {
      const onUpdate = vi.fn();
      const partialResult = makeResult({
        messages: [{ role: 'assistant', content: [{ type: 'text', text: 'Working...' }] }],
      });
      const finalResult = makeResult({
        messages: [{ role: 'assistant', content: [{ type: 'text', text: 'Done.' }] }],
      });

      vi.mocked(spawnAgentWithRetry).mockImplementation(
        async (_cwd, _agent, _task, _vars, _signal, onAgentUpdate) => {
          onAgentUpdate?.(partialResult);
          return finalResult;
        },
      );

      const params: DispatchParams = {
        agent: 'builder',
        task: 'do work',
        phase: 'execute',
        feature: 'auth',
      };

      await executeDispatch(params, CWD, EXTENSION_DIR, undefined, onUpdate);

      expect(onUpdate).toHaveBeenCalled();
      const update: DispatchResult = vi.mocked(onUpdate).mock.calls[0][0];
      expect(update.details.mode).toBe('single');
      expect(update.details.phase).toBe('execute');
      expect(update.details.feature).toBe('auth');
    });
  });

  // ─── parallel mode behavior ──────────────────────────────────────────────

  describe('parallel mode', () => {
    it('spawns all agents in the parallel array', async () => {
      const r1 = makeResult({ agent: 'builder' });
      const r2 = makeResult({ agent: 'scout' });
      vi.mocked(spawnAgentWithRetry)
        .mockResolvedValueOnce(r1)
        .mockResolvedValueOnce(r2);

      const params: DispatchParams = {
        parallel: [
          { agent: 'builder', task: 'task for builder' },
          { agent: 'scout', task: 'task for scout' },
        ],
        phase: 'execute',
        feature: 'auth',
      };

      const result = await executeDispatch(params, CWD, EXTENSION_DIR);
      expect(spawnAgentWithRetry).toHaveBeenCalledTimes(2);
      expect(result.details.results).toHaveLength(2);
    });

    it('writes a dispatch log entry for each parallel agent', async () => {
      vi.mocked(spawnAgentWithRetry)
        .mockResolvedValueOnce(makeResult({ agent: 'builder' }))
        .mockResolvedValueOnce(makeResult({ agent: 'scout' }));

      const params: DispatchParams = {
        parallel: [
          { agent: 'builder', task: 'task 1' },
          { agent: 'scout', task: 'task 2' },
        ],
        phase: 'execute',
        feature: 'auth',
      };

      await executeDispatch(params, CWD, EXTENSION_DIR);
      expect(writeDispatchLog).toHaveBeenCalledTimes(2);
    });

    it('includes phase and feature in details', async () => {
      vi.mocked(spawnAgentWithRetry)
        .mockResolvedValueOnce(makeResult())
        .mockResolvedValueOnce(makeResult());

      const params: DispatchParams = {
        parallel: [
          { agent: 'builder', task: 'task 1' },
          { agent: 'scout', task: 'task 2' },
        ],
        phase: 'execute',
        feature: 'my-feat',
      };

      const result = await executeDispatch(params, CWD, EXTENSION_DIR);
      expect(result.details.phase).toBe('execute');
      expect(result.details.feature).toBe('my-feat');
    });

    it('calls onUpdate with combined results as each agent progresses', async () => {
      const onUpdate = vi.fn();

      vi.mocked(spawnAgentWithRetry)
        .mockImplementationOnce(async (_c, _a, _t, _v, _s, cb) => {
          cb?.(makeResult({ agent: 'builder' }));
          return makeResult({ agent: 'builder' });
        })
        .mockImplementationOnce(async (_c, _a, _t, _v, _s, cb) => {
          cb?.(makeResult({ agent: 'scout' }));
          return makeResult({ agent: 'scout' });
        });

      const params: DispatchParams = {
        parallel: [
          { agent: 'builder', task: 'task 1' },
          { agent: 'scout', task: 'task 2' },
        ],
        phase: 'execute',
        feature: 'auth',
      };

      await executeDispatch(params, CWD, EXTENSION_DIR, undefined, onUpdate);

      expect(onUpdate).toHaveBeenCalled();
      const latestCall: DispatchResult = vi.mocked(onUpdate).mock.calls.at(-1)![0];
      expect(latestCall.details.mode).toBe('parallel');
    });
  });

  // ─── chain mode behavior ─────────────────────────────────────────────────

  describe('chain mode', () => {
    it('executes chain agents sequentially', async () => {
      const callOrder: string[] = [];
      vi.mocked(spawnAgentWithRetry).mockImplementation(async (_c, agent) => {
        callOrder.push(agent.name);
        return makeResult({ agent: agent.name });
      });

      const params: DispatchParams = {
        chain: [
          { agent: 'scout', task: 'analyze' },
          { agent: 'builder', task: 'build' },
        ],
        phase: 'execute',
        feature: 'auth',
      };

      await executeDispatch(params, CWD, EXTENSION_DIR);
      expect(callOrder).toEqual(['scout', 'builder']);
    });

    it('substitutes {previous} with the previous agents final output', async () => {
      const scoutOutput = 'Scout found 3 files to change.';
      const scoutResult = makeResult({
        agent: 'scout',
        messages: [
          { role: 'assistant', content: [{ type: 'text', text: scoutOutput }] },
        ],
      });

      vi.mocked(spawnAgentWithRetry)
        .mockResolvedValueOnce(scoutResult)
        .mockResolvedValueOnce(makeResult({ agent: 'builder' }));

      const params: DispatchParams = {
        chain: [
          { agent: 'scout', task: 'analyze the code' },
          { agent: 'builder', task: 'implement based on: {previous}' },
        ],
        phase: 'execute',
        feature: 'auth',
      };

      await executeDispatch(params, CWD, EXTENSION_DIR);

      const secondCall = vi.mocked(spawnAgentWithRetry).mock.calls[1];
      expect(secondCall[2]).toBe(`implement based on: ${scoutOutput}`);
    });

    it('substitutes all {previous} occurrences in the task', async () => {
      const prevOutput = 'output text';
      vi.mocked(spawnAgentWithRetry)
        .mockResolvedValueOnce(
          makeResult({
            messages: [{ role: 'assistant', content: [{ type: 'text', text: prevOutput }] }],
          }),
        )
        .mockResolvedValueOnce(makeResult());

      const params: DispatchParams = {
        chain: [
          { agent: 'scout', task: 'first step' },
          { agent: 'builder', task: '{previous} and also {previous}' },
        ],
        phase: 'execute',
        feature: 'auth',
      };

      await executeDispatch(params, CWD, EXTENSION_DIR);

      const secondCall = vi.mocked(spawnAgentWithRetry).mock.calls[1];
      expect(secondCall[2]).toBe(`${prevOutput} and also ${prevOutput}`);
    });

    it('uses empty string for {previous} on the first chain step', async () => {
      vi.mocked(spawnAgentWithRetry).mockResolvedValue(makeResult());

      const params: DispatchParams = {
        chain: [
          { agent: 'scout', task: 'analyze with context: {previous}' },
        ],
        phase: 'execute',
        feature: 'auth',
      };

      await executeDispatch(params, CWD, EXTENSION_DIR);

      const firstCall = vi.mocked(spawnAgentWithRetry).mock.calls[0];
      expect(firstCall[2]).toBe('analyze with context: ');
    });

    it('stops processing when an agent returns a non-zero exit code', async () => {
      const failingResult = makeResult({ agent: 'scout', exitCode: 1 });
      vi.mocked(spawnAgentWithRetry).mockResolvedValueOnce(failingResult);

      const params: DispatchParams = {
        chain: [
          { agent: 'scout', task: 'analyze' },
          { agent: 'builder', task: 'implement' },
        ],
        phase: 'execute',
        feature: 'auth',
      };

      const result = await executeDispatch(params, CWD, EXTENSION_DIR);

      // Only first agent ran
      expect(spawnAgentWithRetry).toHaveBeenCalledTimes(1);
      // Partial results returned (not an error result — the dispatch succeeded,
      // but the agent itself failed)
      expect(result.details.results).toHaveLength(1);
    });

    it('writes a dispatch log entry for each completed chain step', async () => {
      vi.mocked(spawnAgentWithRetry)
        .mockResolvedValueOnce(makeResult({ agent: 'scout' }))
        .mockResolvedValueOnce(makeResult({ agent: 'builder' }));

      const params: DispatchParams = {
        chain: [
          { agent: 'scout', task: 'step 1' },
          { agent: 'builder', task: 'step 2' },
        ],
        phase: 'execute',
        feature: 'auth',
      };

      await executeDispatch(params, CWD, EXTENSION_DIR);
      expect(writeDispatchLog).toHaveBeenCalledTimes(2);
    });

    it('only logs completed chain steps when chain is aborted on error', async () => {
      vi.mocked(spawnAgentWithRetry).mockResolvedValueOnce(
        makeResult({ agent: 'scout', exitCode: 1 }),
      );

      const params: DispatchParams = {
        chain: [
          { agent: 'scout', task: 'step 1' },
          { agent: 'builder', task: 'step 2' },
        ],
        phase: 'execute',
        feature: 'auth',
      };

      await executeDispatch(params, CWD, EXTENSION_DIR);
      // Only one log written — the step that completed (even with error)
      expect(writeDispatchLog).toHaveBeenCalledTimes(1);
    });

    it('calls onUpdate with accumulated results after each chain step', async () => {
      const onUpdate = vi.fn();
      vi.mocked(spawnAgentWithRetry)
        .mockResolvedValueOnce(makeResult({ agent: 'scout' }))
        .mockResolvedValueOnce(makeResult({ agent: 'builder' }));

      const params: DispatchParams = {
        chain: [
          { agent: 'scout', task: 'step 1' },
          { agent: 'builder', task: 'step 2' },
        ],
        phase: 'execute',
        feature: 'auth',
      };

      await executeDispatch(params, CWD, EXTENSION_DIR, undefined, onUpdate);

      expect(onUpdate).toHaveBeenCalled();
      const lastCall: DispatchResult = vi.mocked(onUpdate).mock.calls.at(-1)![0];
      expect(lastCall.details.mode).toBe('chain');
    });
  });

  // ─── details shape ───────────────────────────────────────────────────────

  describe('details shape', () => {
    it('sets the correct phase on details for all modes', async () => {
      vi.mocked(spawnAgentWithRetry).mockResolvedValue(makeResult());

      const params: DispatchParams = {
        agent: 'builder',
        task: 'do work',
        phase: 'execute',
        feature: 'my-feature',
      };

      const result = await executeDispatch(params, CWD, EXTENSION_DIR);
      expect(result.details.phase).toBe('execute');
      expect(result.details.feature).toBe('my-feature');
    });

    it('uses the cwd to build paths for loadConfig and discoverAgents', async () => {
      vi.mocked(spawnAgentWithRetry).mockResolvedValue(makeResult());

      const params: DispatchParams = {
        agent: 'builder',
        task: 'do work',
        phase: 'execute',
        feature: 'auth',
      };

      await executeDispatch(params, CWD, EXTENSION_DIR);

      expect(loadConfig).toHaveBeenCalledWith(CWD);
      expect(discoverAgents).toHaveBeenCalledWith(EXTENSION_DIR, CWD);
    });
  });

  // ─── state initialization ────────────────────────────────────────────────

  describe('state initialization', () => {
    const featureDir = path.join(CWD, '.flow', 'features', 'auth');

    it('(a) first dispatch: calls ensureFeatureDir and writeStateFile with initial state', async () => {
      vi.mocked(readStateFile).mockReturnValue(null);
      vi.mocked(spawnAgentWithRetry).mockResolvedValue(makeResult());

      const params: DispatchParams = {
        agent: 'builder',
        task: 'implement feature',
        phase: 'execute',
        feature: 'auth',
        wave: 1,
      };

      await executeDispatch(params, CWD, EXTENSION_DIR);

      expect(ensureFeatureDir).toHaveBeenCalledWith(CWD, 'auth');
      // Init write has budget = 0
      expect(writeStateFile).toHaveBeenCalledWith(
        featureDir,
        expect.objectContaining({
          feature: 'auth',
          current_phase: 'execute',
          current_wave: 1,
          budget: { total_tokens: 0, total_cost_usd: 0 },
        }),
      );
    });

    it('(a) first dispatch: started_at is a non-empty ISO timestamp', async () => {
      vi.mocked(readStateFile).mockReturnValue(null);
      vi.mocked(spawnAgentWithRetry).mockResolvedValue(makeResult());

      const params: DispatchParams = {
        agent: 'builder',
        task: 'implement',
        phase: 'execute',
        feature: 'auth',
      };

      await executeDispatch(params, CWD, EXTENSION_DIR);

      const calls = vi.mocked(writeStateFile).mock.calls;
      const initCall = calls.find((c) => c[1].budget.total_tokens === 0);
      expect(initCall).toBeDefined();
      expect(initCall![1].started_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    });

    it('(a) first dispatch: current_wave is null when wave not provided', async () => {
      vi.mocked(readStateFile).mockReturnValue(null);
      vi.mocked(spawnAgentWithRetry).mockResolvedValue(makeResult());

      const params: DispatchParams = {
        agent: 'builder',
        task: 'implement',
        phase: 'execute',
        feature: 'auth',
      };

      await executeDispatch(params, CWD, EXTENSION_DIR);

      expect(writeStateFile).toHaveBeenCalledWith(
        featureDir,
        expect.objectContaining({ current_wave: null }),
      );
    });

    it('(b) subsequent dispatch: does NOT call ensureFeatureDir', async () => {
      vi.mocked(readStateFile).mockReturnValue(makeFlowState());
      vi.mocked(spawnAgentWithRetry).mockResolvedValue(makeResult());

      const params: DispatchParams = {
        agent: 'builder',
        task: 'implement',
        phase: 'execute',
        feature: 'auth',
      };

      await executeDispatch(params, CWD, EXTENSION_DIR);

      expect(ensureFeatureDir).not.toHaveBeenCalled();
    });

    it('(b) subsequent dispatch: writeStateFile called exactly once (budget update only)', async () => {
      vi.mocked(readStateFile).mockReturnValue(makeFlowState());
      vi.mocked(spawnAgentWithRetry).mockResolvedValue(makeResult());

      const params: DispatchParams = {
        agent: 'builder',
        task: 'implement',
        phase: 'execute',
        feature: 'auth',
      };

      await executeDispatch(params, CWD, EXTENSION_DIR);

      expect(writeStateFile).toHaveBeenCalledTimes(1);
    });
  });

  // ─── budget accumulation ─────────────────────────────────────────────────

  describe('budget accumulation', () => {
    const featureDir = path.join(CWD, '.flow', 'features', 'auth');

    it('(c) single: writeStateFile called with correct budget after execution', async () => {
      vi.mocked(readStateFile).mockReturnValue(makeFlowState({ budget: { total_tokens: 0, total_cost_usd: 0 } }));
      vi.mocked(spawnAgentWithRetry).mockResolvedValue(
        makeResult({ usage: { input: 100, output: 50, cacheRead: 0, cacheWrite: 0, cost: 0.001, contextTokens: 150, turns: 1 } }),
      );

      const params: DispatchParams = {
        agent: 'builder',
        task: 'implement',
        phase: 'execute',
        feature: 'auth',
      };

      await executeDispatch(params, CWD, EXTENSION_DIR);

      expect(writeStateFile).toHaveBeenCalledWith(
        featureDir,
        expect.objectContaining({
          budget: { total_tokens: 150, total_cost_usd: 0.001 },
          current_phase: 'execute',
        }),
      );
    });

    it('(c) single: last_updated is a non-empty ISO timestamp', async () => {
      vi.mocked(readStateFile).mockReturnValue(makeFlowState());
      vi.mocked(spawnAgentWithRetry).mockResolvedValue(makeResult());

      const params: DispatchParams = {
        agent: 'builder',
        task: 'implement',
        phase: 'execute',
        feature: 'auth',
      };

      await executeDispatch(params, CWD, EXTENSION_DIR);

      const call = vi.mocked(writeStateFile).mock.calls.at(-1)!;
      expect(call[1].last_updated).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    });

    it('(c) single: budget accumulates on top of existing state tokens', async () => {
      vi.mocked(readStateFile).mockReturnValue(
        makeFlowState({ budget: { total_tokens: 500, total_cost_usd: 0.01 } }),
      );
      vi.mocked(spawnAgentWithRetry).mockResolvedValue(
        makeResult({ usage: { input: 100, output: 50, cacheRead: 0, cacheWrite: 0, cost: 0.001, contextTokens: 150, turns: 1 } }),
      );

      const params: DispatchParams = {
        agent: 'builder',
        task: 'implement',
        phase: 'execute',
        feature: 'auth',
      };

      await executeDispatch(params, CWD, EXTENSION_DIR);

      expect(writeStateFile).toHaveBeenCalledWith(
        featureDir,
        expect.objectContaining({
          budget: { total_tokens: 650, total_cost_usd: 0.011 },
        }),
      );
    });

    it('(d) parallel: writeStateFile called with budgets summed across all results', async () => {
      vi.mocked(readStateFile).mockReturnValue(makeFlowState({ budget: { total_tokens: 0, total_cost_usd: 0 } }));
      vi.mocked(spawnAgentWithRetry)
        .mockResolvedValueOnce(makeResult({ agent: 'builder', usage: { input: 100, output: 50, cacheRead: 0, cacheWrite: 0, cost: 0.001, contextTokens: 150, turns: 1 } }))
        .mockResolvedValueOnce(makeResult({ agent: 'scout', usage: { input: 200, output: 100, cacheRead: 0, cacheWrite: 0, cost: 0.002, contextTokens: 300, turns: 1 } }));

      const params: DispatchParams = {
        parallel: [
          { agent: 'builder', task: 'task 1' },
          { agent: 'scout', task: 'task 2' },
        ],
        phase: 'execute',
        feature: 'auth',
      };

      await executeDispatch(params, CWD, EXTENSION_DIR);

      expect(writeStateFile).toHaveBeenCalledWith(
        featureDir,
        expect.objectContaining({
          budget: { total_tokens: 450, total_cost_usd: 0.003 },
        }),
      );
    });

    it('(e) chain: writeStateFile called with budgets summed across all completed steps', async () => {
      vi.mocked(readStateFile).mockReturnValue(makeFlowState({ budget: { total_tokens: 0, total_cost_usd: 0 } }));
      vi.mocked(spawnAgentWithRetry)
        .mockResolvedValueOnce(makeResult({ agent: 'scout', usage: { input: 80, output: 40, cacheRead: 0, cacheWrite: 0, cost: 0.0005, contextTokens: 120, turns: 1 } }))
        .mockResolvedValueOnce(makeResult({ agent: 'builder', usage: { input: 120, output: 60, cacheRead: 0, cacheWrite: 0, cost: 0.0015, contextTokens: 180, turns: 1 } }));

      const params: DispatchParams = {
        chain: [
          { agent: 'scout', task: 'analyze' },
          { agent: 'builder', task: 'implement' },
        ],
        phase: 'execute',
        feature: 'auth',
      };

      await executeDispatch(params, CWD, EXTENSION_DIR);

      expect(writeStateFile).toHaveBeenCalledWith(
        featureDir,
        expect.objectContaining({
          budget: { total_tokens: 300, total_cost_usd: 0.002 },
        }),
      );
    });

    it('(e) chain: wave is updated in state when provided', async () => {
      vi.mocked(readStateFile).mockReturnValue(makeFlowState());
      vi.mocked(spawnAgentWithRetry).mockResolvedValue(makeResult());

      const params: DispatchParams = {
        agent: 'builder',
        task: 'implement',
        phase: 'execute',
        feature: 'auth',
        wave: 3,
      };

      await executeDispatch(params, CWD, EXTENSION_DIR);

      const lastCall = vi.mocked(writeStateFile).mock.calls.at(-1)!;
      expect(lastCall[1].current_wave).toBe(3);
    });
  });

  // ─── appendProgressLog ───────────────────────────────────────────────────

  describe('appendProgressLog', () => {
    const featureDir = path.join(CWD, '.flow', 'features', 'auth');

    it('(f) called exactly once per single dispatch', async () => {
      vi.mocked(readStateFile).mockReturnValue(makeFlowState());
      vi.mocked(spawnAgentWithRetry).mockResolvedValue(makeResult({ agent: 'builder' }));

      const params: DispatchParams = {
        agent: 'builder',
        task: 'implement',
        phase: 'execute',
        feature: 'auth',
      };

      await executeDispatch(params, CWD, EXTENSION_DIR);

      expect(appendProgressLog).toHaveBeenCalledTimes(1);
    });

    it('(f) called with featureDir, phase, and message containing agent name', async () => {
      vi.mocked(readStateFile).mockReturnValue(makeFlowState());
      vi.mocked(spawnAgentWithRetry).mockResolvedValue(makeResult({ agent: 'builder' }));

      const params: DispatchParams = {
        agent: 'builder',
        task: 'implement',
        phase: 'execute',
        feature: 'auth',
      };

      await executeDispatch(params, CWD, EXTENSION_DIR);

      expect(appendProgressLog).toHaveBeenCalledWith(
        featureDir,
        'execute',
        expect.stringMatching(/builder/i),
      );
    });

    it('(f) called once for parallel dispatch', async () => {
      vi.mocked(readStateFile).mockReturnValue(makeFlowState());
      vi.mocked(spawnAgentWithRetry)
        .mockResolvedValueOnce(makeResult({ agent: 'builder' }))
        .mockResolvedValueOnce(makeResult({ agent: 'scout' }));

      const params: DispatchParams = {
        parallel: [
          { agent: 'builder', task: 'task 1' },
          { agent: 'scout', task: 'task 2' },
        ],
        phase: 'execute',
        feature: 'auth',
      };

      await executeDispatch(params, CWD, EXTENSION_DIR);

      expect(appendProgressLog).toHaveBeenCalledTimes(1);
    });

    it('(f) called once for chain dispatch', async () => {
      vi.mocked(readStateFile).mockReturnValue(makeFlowState());
      vi.mocked(spawnAgentWithRetry)
        .mockResolvedValueOnce(makeResult({ agent: 'scout' }))
        .mockResolvedValueOnce(makeResult({ agent: 'builder' }));

      const params: DispatchParams = {
        chain: [
          { agent: 'scout', task: 'step 1' },
          { agent: 'builder', task: 'step 2' },
        ],
        phase: 'execute',
        feature: 'auth',
      };

      await executeDispatch(params, CWD, EXTENSION_DIR);

      expect(appendProgressLog).toHaveBeenCalledTimes(1);
    });
  });

  // ─── error resilience ────────────────────────────────────────────────────

  describe('error resilience', () => {
    it('writeStateFile throws: executeDispatch still returns a result', async () => {
      vi.mocked(readStateFile).mockReturnValue(makeFlowState());
      vi.mocked(writeStateFile).mockImplementation(() => { throw new Error('disk full'); });
      vi.mocked(spawnAgentWithRetry).mockResolvedValue(makeResult());

      const params: DispatchParams = {
        agent: 'builder',
        task: 'implement',
        phase: 'execute',
        feature: 'auth',
      };

      const result = await executeDispatch(params, CWD, EXTENSION_DIR);

      expect(result.isError).toBeUndefined();
      expect(result.content[0].text).toBeTruthy();
    });

    it('appendProgressLog throws: executeDispatch still returns a result', async () => {
      vi.mocked(readStateFile).mockReturnValue(makeFlowState());
      vi.mocked(appendProgressLog).mockImplementation(() => { throw new Error('log write failed'); });
      vi.mocked(spawnAgentWithRetry).mockResolvedValue(makeResult());

      const params: DispatchParams = {
        agent: 'builder',
        task: 'implement',
        phase: 'execute',
        feature: 'auth',
      };

      const result = await executeDispatch(params, CWD, EXTENSION_DIR);

      expect(result.isError).toBeUndefined();
      expect(result.content[0].text).toBeTruthy();
    });
  });
});
