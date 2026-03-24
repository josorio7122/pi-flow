import { describe, it, expect, vi, beforeEach } from 'vitest';
import { execSync } from 'node:child_process';
import * as path from 'node:path';
import type { FlowAgentConfig, FlowConfig, FlowState, SingleAgentResult } from './types.js';

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
  writeCheckpoint: vi.fn(),
}));

vi.mock('./gates.js', () => ({
  checkPhaseGate: vi.fn().mockReturnValue({ canAdvance: true, reason: 'ok' }),
}));

vi.mock('node:fs', () => ({
  existsSync: vi.fn(),
  readFileSync: vi.fn(),
  writeFileSync: vi.fn(),
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
import {
  writeDispatchLog,
  writeStateFile,
  ensureFeatureDir,
  appendProgressLog,
  readStateFile,
  writeCheckpoint,
} from './state.js';
import { checkPhaseGate } from './gates.js';
import * as fs from 'node:fs';

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
      vi.mocked(spawnAgentWithRetry).mockResolvedValueOnce(r1).mockResolvedValueOnce(r2);

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
      vi.mocked(spawnAgentWithRetry).mockResolvedValueOnce(r1).mockResolvedValueOnce(r2);

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
      expect(call[4]).toBeUndefined(); // signal
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
      vi.mocked(spawnAgentWithRetry).mockResolvedValueOnce(r1).mockResolvedValueOnce(r2);

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
        messages: [{ role: 'assistant', content: [{ type: 'text', text: scoutOutput }] }],
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
        chain: [{ agent: 'scout', task: 'analyze with context: {previous}' }],
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
      vi.mocked(readStateFile).mockReturnValue(
        makeFlowState({ budget: { total_tokens: 0, total_cost_usd: 0 } }),
      );
      vi.mocked(spawnAgentWithRetry).mockResolvedValue(
        makeResult({
          usage: {
            input: 100,
            output: 50,
            cacheRead: 0,
            cacheWrite: 0,
            cost: 0.001,
            contextTokens: 150,
            turns: 1,
          },
        }),
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
        makeResult({
          usage: {
            input: 100,
            output: 50,
            cacheRead: 0,
            cacheWrite: 0,
            cost: 0.001,
            contextTokens: 150,
            turns: 1,
          },
        }),
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
      vi.mocked(readStateFile).mockReturnValue(
        makeFlowState({ budget: { total_tokens: 0, total_cost_usd: 0 } }),
      );
      vi.mocked(spawnAgentWithRetry)
        .mockResolvedValueOnce(
          makeResult({
            agent: 'builder',
            usage: {
              input: 100,
              output: 50,
              cacheRead: 0,
              cacheWrite: 0,
              cost: 0.001,
              contextTokens: 150,
              turns: 1,
            },
          }),
        )
        .mockResolvedValueOnce(
          makeResult({
            agent: 'scout',
            usage: {
              input: 200,
              output: 100,
              cacheRead: 0,
              cacheWrite: 0,
              cost: 0.002,
              contextTokens: 300,
              turns: 1,
            },
          }),
        );

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
      vi.mocked(readStateFile).mockReturnValue(
        makeFlowState({ budget: { total_tokens: 0, total_cost_usd: 0 } }),
      );
      vi.mocked(spawnAgentWithRetry)
        .mockResolvedValueOnce(
          makeResult({
            agent: 'scout',
            usage: {
              input: 80,
              output: 40,
              cacheRead: 0,
              cacheWrite: 0,
              cost: 0.0005,
              contextTokens: 120,
              turns: 1,
            },
          }),
        )
        .mockResolvedValueOnce(
          makeResult({
            agent: 'builder',
            usage: {
              input: 120,
              output: 60,
              cacheRead: 0,
              cacheWrite: 0,
              cost: 0.0015,
              contextTokens: 180,
              turns: 1,
            },
          }),
        );

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
      vi.mocked(writeStateFile).mockImplementation(() => {
        throw new Error('disk full');
      });
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
      vi.mocked(appendProgressLog).mockImplementation(() => {
        throw new Error('log write failed');
      });
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

  // ─── gate enforcement ────────────────────────────────────────────────────

  describe('gate enforcement', () => {
    it('(a) gate blocks: returns isError=true with "Gate" and reason in content', async () => {
      vi.mocked(readStateFile).mockReturnValue(makeFlowState());
      vi.mocked(checkPhaseGate).mockReturnValue({ canAdvance: false, reason: 'spec not approved' });

      const params: DispatchParams = {
        agent: 'builder',
        task: 'implement',
        phase: 'execute',
        feature: 'auth',
      };

      const result = await executeDispatch(params, CWD, EXTENSION_DIR);

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toMatch(/Gate/);
      expect(result.content[0].text).toContain('spec not approved');
    });

    it('(a) gate blocks: spawnAgentWithRetry is NOT called', async () => {
      vi.mocked(readStateFile).mockReturnValue(makeFlowState());
      vi.mocked(checkPhaseGate).mockReturnValue({
        canAdvance: false,
        reason: 'design not approved',
      });

      const params: DispatchParams = {
        agent: 'builder',
        task: 'implement',
        phase: 'execute',
        feature: 'auth',
      };

      await executeDispatch(params, CWD, EXTENSION_DIR);

      expect(spawnAgentWithRetry).not.toHaveBeenCalled();
    });

    it('(a) gate blocks: writeStateFile NOT called when existing state (no init write needed)', async () => {
      vi.mocked(readStateFile).mockReturnValue(makeFlowState());
      vi.mocked(checkPhaseGate).mockReturnValue({ canAdvance: false, reason: 'blocked' });

      const params: DispatchParams = {
        agent: 'builder',
        task: 'implement',
        phase: 'execute',
        feature: 'auth',
      };

      await executeDispatch(params, CWD, EXTENSION_DIR);

      // readStateFile returns existing state → no init write; gate blocks → no budget write
      expect(writeStateFile).not.toHaveBeenCalled();
    });

    it('(b) gate passes: execution proceeds, spawnAgentWithRetry is called', async () => {
      vi.mocked(readStateFile).mockReturnValue(makeFlowState());
      vi.mocked(checkPhaseGate).mockReturnValue({ canAdvance: true, reason: 'ok' });
      vi.mocked(spawnAgentWithRetry).mockResolvedValue(makeResult());

      const params: DispatchParams = {
        agent: 'builder',
        task: 'implement',
        phase: 'execute',
        feature: 'auth',
      };

      const result = await executeDispatch(params, CWD, EXTENSION_DIR);

      expect(result.isError).toBeUndefined();
      expect(spawnAgentWithRetry).toHaveBeenCalledTimes(1);
    });

    it('(c) gate throws: treated as blocked, result.isError is true', async () => {
      vi.mocked(readStateFile).mockReturnValue(makeFlowState());
      vi.mocked(checkPhaseGate).mockImplementation(() => {
        throw new Error('gate file missing');
      });

      const params: DispatchParams = {
        agent: 'builder',
        task: 'implement',
        phase: 'execute',
        feature: 'auth',
      };

      const result = await executeDispatch(params, CWD, EXTENSION_DIR);

      expect(result.isError).toBe(true);
      expect(spawnAgentWithRetry).not.toHaveBeenCalled();
    });

    it('(d) gate check uses featureDir derived from cwd + feature, not hardcoded', async () => {
      vi.mocked(readStateFile).mockReturnValue(makeFlowState({ feature: 'my-feature' }));
      vi.mocked(checkPhaseGate).mockReturnValue({ canAdvance: true, reason: 'ok' });
      vi.mocked(spawnAgentWithRetry).mockResolvedValue(makeResult());

      const params: DispatchParams = {
        agent: 'builder',
        task: 'implement',
        phase: 'execute',
        feature: 'my-feature',
      };

      await executeDispatch(params, CWD, EXTENSION_DIR);

      const expectedFeatureDir = path.join(CWD, '.flow', 'features', 'my-feature');
      expect(checkPhaseGate).toHaveBeenCalledWith('execute', expectedFeatureDir);
    });

    it('(e) gate blocks even for intent phase if checkPhaseGate returns canAdvance: false', async () => {
      vi.mocked(readStateFile).mockReturnValue(makeFlowState({ current_phase: 'intent' }));
      vi.mocked(checkPhaseGate).mockReturnValue({ canAdvance: false, reason: 'unexpected block' });
      vi.mocked(discoverAgents).mockReturnValue([
        makeAgent({ name: 'clarifier', phases: ['intent'] }),
      ]);

      const params: DispatchParams = {
        agent: 'clarifier',
        task: 'clarify',
        phase: 'intent',
        feature: 'auth',
      };

      const result = await executeDispatch(params, CWD, EXTENSION_DIR);

      expect(result.isError).toBe(true);
      expect(spawnAgentWithRetry).not.toHaveBeenCalled();
    });
  });

  // ─── task-3.1: chain placeholder array ──────────────────────────────────

  describe('chain placeholder array (task-3.1)', () => {
    beforeEach(() => {
      vi.mocked(readStateFile).mockReturnValue(makeFlowState());
      vi.mocked(checkPhaseGate).mockReturnValue({ canAdvance: true, reason: 'ok' });
    });

    it('(a) every onUpdate in a 3-step chain receives details.results with length === 3', async () => {
      const onUpdate = vi.fn();
      vi.mocked(spawnAgentWithRetry)
        .mockResolvedValueOnce(makeResult({ agent: 'scout' }))
        .mockResolvedValueOnce(makeResult({ agent: 'builder' }))
        .mockResolvedValueOnce(makeResult({ agent: 'scout' }));

      const params: DispatchParams = {
        chain: [
          { agent: 'scout', task: 'step 1' },
          { agent: 'builder', task: 'step 2' },
          { agent: 'scout', task: 'step 3' },
        ],
        phase: 'execute',
        feature: 'auth',
      };

      await executeDispatch(params, CWD, EXTENSION_DIR, undefined, onUpdate);

      for (const call of vi.mocked(onUpdate).mock.calls) {
        const update: DispatchResult = call[0];
        expect(update.details.results).toHaveLength(3);
      }
    });

    it('(b) 3-step successful chain: final details.results has length === 3 with all exitCodes 0', async () => {
      vi.mocked(spawnAgentWithRetry)
        .mockResolvedValueOnce(makeResult({ agent: 'scout', exitCode: 0 }))
        .mockResolvedValueOnce(makeResult({ agent: 'builder', exitCode: 0 }))
        .mockResolvedValueOnce(makeResult({ agent: 'scout', exitCode: 0 }));

      const params: DispatchParams = {
        chain: [
          { agent: 'scout', task: 'step 1' },
          { agent: 'builder', task: 'step 2' },
          { agent: 'scout', task: 'step 3' },
        ],
        phase: 'execute',
        feature: 'auth',
      };

      const result = await executeDispatch(params, CWD, EXTENSION_DIR);

      expect(result.details.results).toHaveLength(3);
      expect(result.details.results.every((r) => r.exitCode === 0)).toBe(true);
    });

    it('(c) chain error at step 2: final results.length === 2, step 3 absent', async () => {
      vi.mocked(spawnAgentWithRetry)
        .mockResolvedValueOnce(makeResult({ agent: 'scout', exitCode: 0 }))
        .mockResolvedValueOnce(makeResult({ agent: 'builder', exitCode: 1 }));

      const params: DispatchParams = {
        chain: [
          { agent: 'scout', task: 'step 1' },
          { agent: 'builder', task: 'step 2' },
          { agent: 'scout', task: 'step 3' },
        ],
        phase: 'execute',
        feature: 'auth',
      };

      const result = await executeDispatch(params, CWD, EXTENSION_DIR);

      expect(result.details.results).toHaveLength(2);
      expect(result.details.results[0].exitCode).toBe(0);
      expect(result.details.results[1].exitCode).toBe(1);
    });

    it('(c) onUpdate during error chain still shows length 3', async () => {
      const onUpdate = vi.fn();
      vi.mocked(spawnAgentWithRetry)
        .mockResolvedValueOnce(makeResult({ agent: 'scout', exitCode: 0 }))
        .mockResolvedValueOnce(makeResult({ agent: 'builder', exitCode: 1 }));

      const params: DispatchParams = {
        chain: [
          { agent: 'scout', task: 'step 1' },
          { agent: 'builder', task: 'step 2' },
          { agent: 'scout', task: 'step 3' },
        ],
        phase: 'execute',
        feature: 'auth',
      };

      await executeDispatch(params, CWD, EXTENSION_DIR, undefined, onUpdate);

      for (const call of vi.mocked(onUpdate).mock.calls) {
        const update: DispatchResult = call[0];
        expect(update.details.results).toHaveLength(3);
      }
    });

    it('(d) {previous} substitution still works correctly with placeholder array', async () => {
      const scoutOutput = 'Scout analysis complete.';
      vi.mocked(spawnAgentWithRetry)
        .mockResolvedValueOnce(
          makeResult({
            agent: 'scout',
            messages: [{ role: 'assistant', content: [{ type: 'text', text: scoutOutput }] }],
          }),
        )
        .mockResolvedValueOnce(makeResult({ agent: 'builder' }))
        .mockResolvedValueOnce(makeResult({ agent: 'scout' }));

      const params: DispatchParams = {
        chain: [
          { agent: 'scout', task: 'analyze' },
          { agent: 'builder', task: 'build based on: {previous}' },
          { agent: 'scout', task: 'verify' },
        ],
        phase: 'execute',
        feature: 'auth',
      };

      await executeDispatch(params, CWD, EXTENSION_DIR);

      const secondCall = vi.mocked(spawnAgentWithRetry).mock.calls[1];
      expect(secondCall[2]).toBe(`build based on: ${scoutOutput}`);
    });

    it('(edge) 1-step chain: onUpdate shows length 1, final result has length 1', async () => {
      const onUpdate = vi.fn();
      vi.mocked(spawnAgentWithRetry).mockResolvedValueOnce(makeResult({ agent: 'scout' }));

      const params: DispatchParams = {
        chain: [{ agent: 'scout', task: 'step 1' }],
        phase: 'execute',
        feature: 'auth',
      };

      const result = await executeDispatch(params, CWD, EXTENSION_DIR, undefined, onUpdate);

      expect(result.details.results).toHaveLength(1);
      for (const call of vi.mocked(onUpdate).mock.calls) {
        expect((call[0] as DispatchResult).details.results).toHaveLength(1);
      }
    });

    it('(edge) chain error at step 1: final result has length 1', async () => {
      vi.mocked(spawnAgentWithRetry).mockResolvedValueOnce(
        makeResult({ agent: 'scout', exitCode: 1 }),
      );

      const params: DispatchParams = {
        chain: [
          { agent: 'scout', task: 'step 1' },
          { agent: 'builder', task: 'step 2' },
          { agent: 'scout', task: 'step 3' },
        ],
        phase: 'execute',
        feature: 'auth',
      };

      const result = await executeDispatch(params, CWD, EXTENSION_DIR);

      expect(result.details.results).toHaveLength(1);
    });
  });

  // ─── task-3.2: writeCheckpoint wiring ───────────────────────────────────

  describe('writeCheckpoint wiring (task-3.2)', () => {
    const featureDir = path.join(CWD, '.flow', 'features', 'auth');

    beforeEach(() => {
      vi.mocked(readStateFile).mockReturnValue(makeFlowState());
      vi.mocked(checkPhaseGate).mockReturnValue({ canAdvance: true, reason: 'ok' });
    });

    it('(a) successful single dispatch: writeCheckpoint called once with featureDir, phase, wave, snapshot', async () => {
      vi.mocked(spawnAgentWithRetry).mockResolvedValue(makeResult());

      const params: DispatchParams = {
        agent: 'builder',
        task: 'implement',
        phase: 'execute',
        feature: 'auth',
        wave: 2,
      };

      await executeDispatch(params, CWD, EXTENSION_DIR);

      expect(writeCheckpoint).toHaveBeenCalledTimes(1);
      expect(writeCheckpoint).toHaveBeenCalledWith(featureDir, 'execute', 2, expect.any(String));
      const snapshotArg = vi.mocked(writeCheckpoint).mock.calls[0][3] as string;
      expect(snapshotArg.length).toBeGreaterThan(0);
    });

    it('(a) wave undefined: writeCheckpoint called with null for wave', async () => {
      vi.mocked(spawnAgentWithRetry).mockResolvedValue(makeResult());

      const params: DispatchParams = {
        agent: 'builder',
        task: 'implement',
        phase: 'execute',
        feature: 'auth',
      };

      await executeDispatch(params, CWD, EXTENSION_DIR);

      expect(writeCheckpoint).toHaveBeenCalledWith(featureDir, 'execute', null, expect.any(String));
    });

    it('(b) gate blocked: writeCheckpoint NOT called', async () => {
      vi.mocked(checkPhaseGate).mockReturnValue({ canAdvance: false, reason: 'blocked' });

      const params: DispatchParams = {
        agent: 'builder',
        task: 'implement',
        phase: 'execute',
        feature: 'auth',
      };

      await executeDispatch(params, CWD, EXTENSION_DIR);

      expect(writeCheckpoint).not.toHaveBeenCalled();
    });

    it('(b) agent not found: writeCheckpoint NOT called', async () => {
      const params: DispatchParams = {
        agent: 'nonexistent',
        task: 'implement',
        phase: 'execute',
        feature: 'auth',
      };

      await executeDispatch(params, CWD, EXTENSION_DIR);

      expect(writeCheckpoint).not.toHaveBeenCalled();
    });

    it('(c) chain step fails: writeCheckpoint NOT called', async () => {
      vi.mocked(spawnAgentWithRetry)
        .mockResolvedValueOnce(makeResult({ agent: 'scout', exitCode: 0 }))
        .mockResolvedValueOnce(makeResult({ agent: 'builder', exitCode: 1 }));

      const params: DispatchParams = {
        chain: [
          { agent: 'scout', task: 'step 1' },
          { agent: 'builder', task: 'step 2' },
        ],
        phase: 'execute',
        feature: 'auth',
      };

      await executeDispatch(params, CWD, EXTENSION_DIR);

      expect(writeCheckpoint).not.toHaveBeenCalled();
    });

    it('(d) successful parallel dispatch: writeCheckpoint called once', async () => {
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

      expect(writeCheckpoint).toHaveBeenCalledTimes(1);
    });

    it('(e) successful chain dispatch (all steps pass): writeCheckpoint called once', async () => {
      vi.mocked(spawnAgentWithRetry)
        .mockResolvedValueOnce(makeResult({ agent: 'scout', exitCode: 0 }))
        .mockResolvedValueOnce(makeResult({ agent: 'builder', exitCode: 0 }));

      const params: DispatchParams = {
        chain: [
          { agent: 'scout', task: 'step 1' },
          { agent: 'builder', task: 'step 2' },
        ],
        phase: 'execute',
        feature: 'auth',
      };

      await executeDispatch(params, CWD, EXTENSION_DIR);

      expect(writeCheckpoint).toHaveBeenCalledTimes(1);
    });

    it('writeCheckpoint throws: dispatch result still returned', async () => {
      vi.mocked(writeCheckpoint).mockImplementation(() => {
        throw new Error('disk full');
      });
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

  // ─── task-4.1: markTaskComplete wiring ──────────────────────────────────

  describe('markTaskComplete wiring (task-4.1)', () => {
    const featureDir = path.join(CWD, '.flow', 'features', 'auth');
    const tasksPath = path.join(featureDir, 'tasks.md');
    const tasksContent = '- [ ] task-1.1\n- [ ] task-1.2\nSome other line\n';

    beforeEach(() => {
      vi.mocked(readStateFile).mockReturnValue(makeFlowState());
      vi.mocked(checkPhaseGate).mockReturnValue({ canAdvance: true, reason: 'ok' });
    });

    it('(a) single dispatch with task-1.1 in task string: writeFileSync called with [x] and other lines unchanged', async () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(tasksContent);
      vi.mocked(spawnAgentWithRetry).mockResolvedValue(
        makeResult({ task: 'implement task-1.1', exitCode: 0 }),
      );

      const params: DispatchParams = {
        agent: 'builder',
        task: 'implement task-1.1',
        phase: 'execute',
        feature: 'auth',
      };

      await executeDispatch(params, CWD, EXTENSION_DIR);

      expect(fs.writeFileSync).toHaveBeenCalledWith(
        tasksPath,
        expect.stringContaining('- [x] task-1.1'),
        'utf8',
      );
      const written = vi.mocked(fs.writeFileSync).mock.calls[0][1] as string;
      expect(written).toContain('- [ ] task-1.2');
      expect(written).toContain('Some other line');
      expect(written).not.toContain('- [ ] task-1.1');
    });

    it('(b) tasks.md does not exist: no error, dispatch succeeds, writeFileSync not called', async () => {
      vi.mocked(fs.existsSync).mockReturnValue(false);
      vi.mocked(spawnAgentWithRetry).mockResolvedValue(
        makeResult({ task: 'implement task-1.1', exitCode: 0 }),
      );

      const params: DispatchParams = {
        agent: 'builder',
        task: 'implement task-1.1',
        phase: 'execute',
        feature: 'auth',
      };

      const result = await executeDispatch(params, CWD, EXTENSION_DIR);

      expect(result.isError).toBeUndefined();
      expect(fs.writeFileSync).not.toHaveBeenCalled();
    });

    it('(c) task string has no task-N.M pattern: tasks.md not modified', async () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(tasksContent);
      vi.mocked(spawnAgentWithRetry).mockResolvedValue(
        makeResult({ task: 'implement the feature', exitCode: 0 }),
      );

      const params: DispatchParams = {
        agent: 'builder',
        task: 'implement the feature',
        phase: 'execute',
        feature: 'auth',
      };

      await executeDispatch(params, CWD, EXTENSION_DIR);

      expect(fs.writeFileSync).not.toHaveBeenCalled();
    });

    it('(d) non-builder agent: task still marked when task string matches (not agent-gated)', async () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(tasksContent);
      vi.mocked(spawnAgentWithRetry).mockResolvedValue(
        makeResult({ agent: 'scout', task: 'analyze task-1.1', exitCode: 0 }),
      );

      const params: DispatchParams = {
        agent: 'scout',
        task: 'analyze task-1.1',
        phase: 'execute',
        feature: 'auth',
      };

      await executeDispatch(params, CWD, EXTENSION_DIR);

      expect(fs.writeFileSync).toHaveBeenCalledWith(
        tasksPath,
        expect.stringContaining('- [x] task-1.1'),
        'utf8',
      );
    });

    it('(e) parallel dispatch: each successful step task marked individually', async () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(tasksContent);
      vi.mocked(spawnAgentWithRetry)
        .mockResolvedValueOnce(
          makeResult({ agent: 'builder', task: 'implement task-1.1', exitCode: 0 }),
        )
        .mockResolvedValueOnce(
          makeResult({ agent: 'scout', task: 'analyze task-1.2', exitCode: 0 }),
        );

      const params: DispatchParams = {
        parallel: [
          { agent: 'builder', task: 'implement task-1.1' },
          { agent: 'scout', task: 'analyze task-1.2' },
        ],
        phase: 'execute',
        feature: 'auth',
      };

      await executeDispatch(params, CWD, EXTENSION_DIR);

      expect(fs.writeFileSync).toHaveBeenCalledTimes(2);
    });

    it('(f) agent exits non-zero: task NOT marked', async () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(tasksContent);
      vi.mocked(spawnAgentWithRetry).mockResolvedValue(
        makeResult({ task: 'implement task-1.1', exitCode: 1 }),
      );

      const params: DispatchParams = {
        agent: 'builder',
        task: 'implement task-1.1',
        phase: 'execute',
        feature: 'auth',
      };

      await executeDispatch(params, CWD, EXTENSION_DIR);

      expect(fs.writeFileSync).not.toHaveBeenCalled();
    });

    it('(g) dispatch returns isError (gate blocked): tasks.md not touched', async () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(tasksContent);
      vi.mocked(checkPhaseGate).mockReturnValue({ canAdvance: false, reason: 'blocked' });

      const params: DispatchParams = {
        agent: 'builder',
        task: 'implement task-1.1',
        phase: 'execute',
        feature: 'auth',
      };

      const result = await executeDispatch(params, CWD, EXTENSION_DIR);

      expect(result.isError).toBe(true);
      expect(fs.writeFileSync).not.toHaveBeenCalled();
    });

    it('markTaskComplete throws (writeFileSync errors): dispatch still returns normally', async () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(tasksContent);
      vi.mocked(fs.writeFileSync).mockImplementation(() => {
        throw new Error('permission denied');
      });
      vi.mocked(spawnAgentWithRetry).mockResolvedValue(
        makeResult({ task: 'implement task-1.1', exitCode: 0 }),
      );

      const params: DispatchParams = {
        agent: 'builder',
        task: 'implement task-1.1',
        phase: 'execute',
        feature: 'auth',
      };

      const result = await executeDispatch(params, CWD, EXTENSION_DIR);

      expect(result.isError).toBeUndefined();
      expect(result.content[0].text).toBeTruthy();
    });

    it('tasks.md has no matching line: no crash, writeFileSync not called', async () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue('- [ ] task-2.1\nSome other line\n');
      vi.mocked(spawnAgentWithRetry).mockResolvedValue(
        makeResult({ task: 'implement task-1.1', exitCode: 0 }),
      );

      const params: DispatchParams = {
        agent: 'builder',
        task: 'implement task-1.1',
        phase: 'execute',
        feature: 'auth',
      };

      const result = await executeDispatch(params, CWD, EXTENSION_DIR);

      expect(result.isError).toBeUndefined();
      expect(fs.writeFileSync).not.toHaveBeenCalled();
    });
  });
});

// ─── integration: full lifecycle sequence ─────────────────────────────────────

describe('integration: full lifecycle sequence', () => {
  const builder = makeAgent({ name: 'builder', phases: ['execute'] });
  const scout = makeAgent({ name: 'scout', phases: ['execute'] });

  // Tracks the sequence of key mock invocations for call-order assertions
  let callOrder: string[];

  beforeEach(() => {
    callOrder = [];
    vi.clearAllMocks();

    vi.mocked(loadConfig).mockReturnValue(makeConfig());
    vi.mocked(buildVariableMap).mockReturnValue({ FEATURE_NAME: 'auth' });
    vi.mocked(writeDispatchLog).mockReturnValue(undefined);
    vi.mocked(fs.existsSync).mockReturnValue(false);
    vi.mocked(fs.readFileSync).mockReturnValue('');

    // Default: first-dispatch scenario (readStateFile returns null)
    vi.mocked(readStateFile).mockReturnValue(null);

    // Wire order-tracking into every mock of interest
    vi.mocked(ensureFeatureDir).mockImplementation((_cwd, _feature) => {
      callOrder.push('ensureFeatureDir');
      return '';
    });
    vi.mocked(writeStateFile).mockImplementation(() => {
      callOrder.push('writeStateFile');
    });
    vi.mocked(checkPhaseGate).mockImplementation(() => {
      callOrder.push('checkPhaseGate');
      return { canAdvance: true, reason: 'ok' };
    });
    vi.mocked(discoverAgents).mockImplementation(() => {
      callOrder.push('discoverAgents');
      return [builder, scout];
    });
    vi.mocked(spawnAgentWithRetry).mockImplementation(async () => {
      callOrder.push('spawnAgentWithRetry');
      return makeResult();
    });
    vi.mocked(writeCheckpoint).mockImplementation(() => {
      callOrder.push('writeCheckpoint');
    });
    vi.mocked(appendProgressLog).mockImplementation(() => {
      callOrder.push('appendProgressLog');
    });
  });

  it('(a) first-dispatch state creation sequence: ensureFeatureDir → writeStateFile(init) → checkPhaseGate → discoverAgents → spawnAgentWithRetry → writeStateFile(budget) → writeCheckpoint → appendProgressLog', async () => {
    const params: DispatchParams = {
      agent: 'builder',
      task: 'implement task-1.1',
      phase: 'execute',
      feature: 'auth',
    };

    await executeDispatch(params, CWD, EXTENSION_DIR);

    expect(callOrder).toEqual([
      'ensureFeatureDir',
      'writeStateFile', // init write
      'checkPhaseGate',
      'discoverAgents',
      'spawnAgentWithRetry',
      'writeStateFile', // budget write
      'writeCheckpoint',
      'appendProgressLog',
    ]);
  });

  it('(b) gate blocks execution: spawnAgentWithRetry and writeCheckpoint not called; state IS initialised on first dispatch', async () => {
    vi.mocked(checkPhaseGate).mockImplementation(() => {
      callOrder.push('checkPhaseGate');
      return { canAdvance: false, reason: 'design not approved' };
    });

    const params: DispatchParams = {
      agent: 'builder',
      task: 'implement feature',
      phase: 'execute',
      feature: 'auth',
    };

    const result = await executeDispatch(params, CWD, EXTENSION_DIR);

    // Error result with the gate reason
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('design not approved');

    // State IS initialised (ensureFeatureDir + writeStateFile called before the gate)
    expect(callOrder).toContain('ensureFeatureDir');
    expect(callOrder.filter((c) => c === 'writeStateFile')).toHaveLength(1);
    expect(callOrder.indexOf('ensureFeatureDir')).toBeLessThan(callOrder.indexOf('checkPhaseGate'));

    // Agents were never spawned; no checkpoint written
    expect(spawnAgentWithRetry).not.toHaveBeenCalled();
    expect(writeCheckpoint).not.toHaveBeenCalled();
  });

  it('(c) 3-step chain counter: every onUpdate shows results.length === 3; final results.length === 3; budget accumulated from all 3 steps', async () => {
    const step1Usage = {
      input: 100,
      output: 50,
      cacheRead: 0,
      cacheWrite: 0,
      cost: 0.001,
      contextTokens: 150,
      turns: 1,
    };
    const step2Usage = {
      input: 200,
      output: 80,
      cacheRead: 0,
      cacheWrite: 0,
      cost: 0.002,
      contextTokens: 280,
      turns: 1,
    };
    const step3Usage = {
      input: 150,
      output: 60,
      cacheRead: 0,
      cacheWrite: 0,
      cost: 0.0015,
      contextTokens: 210,
      turns: 1,
    };

    vi.mocked(spawnAgentWithRetry)
      .mockImplementation(async () => {
        callOrder.push('spawnAgentWithRetry');
        return makeResult({ usage: step1Usage });
      })
      .mockImplementationOnce(async () => {
        callOrder.push('spawnAgentWithRetry');
        return makeResult({ usage: step1Usage });
      })
      .mockImplementationOnce(async (_cwd, _agent, _task, _vm, _sig, _onAgentUpdate) => {
        callOrder.push('spawnAgentWithRetry');
        return makeResult({ usage: step2Usage });
      })
      .mockImplementationOnce(async () => {
        callOrder.push('spawnAgentWithRetry');
        return makeResult({ usage: step3Usage });
      });

    const updateLengths: number[] = [];
    const onUpdate = (partial: DispatchResult) => {
      updateLengths.push(partial.details.results.length);
    };

    const params: DispatchParams = {
      chain: [
        { agent: 'builder', task: 'step 1' },
        { agent: 'builder', task: 'step 2' },
        { agent: 'builder', task: 'step 3' },
      ],
      phase: 'execute',
      feature: 'auth',
    };

    const result = await executeDispatch(params, CWD, EXTENSION_DIR, undefined, onUpdate);

    // All onUpdate calls reported the full 3-slot array
    expect(updateLengths.length).toBeGreaterThan(0);
    expect(updateLengths.every((len) => len === 3)).toBe(true);

    // Final result carries all 3 steps
    expect(result.details.results).toHaveLength(3);
    expect(result.details.results.every((r) => r.exitCode === 0)).toBe(true);

    // Budget was accumulated across all 3 steps
    const expectedTokens =
      step1Usage.input +
      step1Usage.output +
      (step2Usage.input + step2Usage.output) +
      (step3Usage.input + step3Usage.output);
    const expectedCost = step1Usage.cost + step2Usage.cost + step3Usage.cost;

    const budgetCall = vi
      .mocked(writeStateFile)
      .mock.calls.find(([, state]) => (state as FlowState).budget.total_tokens > 0);
    expect(budgetCall).toBeDefined();
    const budgetState = budgetCall![1] as FlowState;
    expect(budgetState.budget.total_tokens).toBe(expectedTokens);
    expect(budgetState.budget.total_cost_usd).toBeCloseTo(expectedCost, 6);
  });

  it('(d) chain error at step 2: results.length === 2; writeCheckpoint not called; budget covers steps 1+2 only', async () => {
    const step1Usage = {
      input: 100,
      output: 50,
      cacheRead: 0,
      cacheWrite: 0,
      cost: 0.001,
      contextTokens: 150,
      turns: 1,
    };
    const step2Usage = {
      input: 200,
      output: 80,
      cacheRead: 0,
      cacheWrite: 0,
      cost: 0.002,
      contextTokens: 280,
      turns: 1,
    };

    vi.mocked(spawnAgentWithRetry)
      .mockResolvedValueOnce(makeResult({ usage: step1Usage, exitCode: 0 }))
      .mockResolvedValueOnce(makeResult({ usage: step2Usage, exitCode: 1 }));

    const params: DispatchParams = {
      chain: [
        { agent: 'builder', task: 'step 1' },
        { agent: 'builder', task: 'step 2' },
        { agent: 'builder', task: 'step 3' },
      ],
      phase: 'execute',
      feature: 'auth',
    };

    const result = await executeDispatch(params, CWD, EXTENSION_DIR);

    // Only steps 1 and 2 appear in results (step 3 was never attempted)
    expect(result.details.results).toHaveLength(2);

    // No checkpoint when chain fails
    expect(writeCheckpoint).not.toHaveBeenCalled();

    // Budget covers only steps 1+2
    const expectedTokens =
      step1Usage.input + step1Usage.output + (step2Usage.input + step2Usage.output);
    const expectedCost = step1Usage.cost + step2Usage.cost;

    const budgetCall = vi
      .mocked(writeStateFile)
      .mock.calls.find(([, state]) => (state as FlowState).budget.total_tokens > 0);
    expect(budgetCall).toBeDefined();
    const budgetState = budgetCall![1] as FlowState;
    expect(budgetState.budget.total_tokens).toBe(expectedTokens);
    expect(budgetState.budget.total_cost_usd).toBeCloseTo(expectedCost, 6);

    // spawnAgentWithRetry was called exactly twice
    expect(spawnAgentWithRetry).toHaveBeenCalledTimes(2);
  });

  it('(e) footer auto-fix: writeStateFile called on first dispatch proves state.md is created; second dispatch proceeds without re-init', async () => {
    // First dispatch: readStateFile returns null → state is created
    vi.mocked(readStateFile).mockReturnValueOnce(null);
    vi.mocked(spawnAgentWithRetry).mockResolvedValue(makeResult());

    const params: DispatchParams = {
      agent: 'builder',
      task: 'implement feature',
      phase: 'execute',
      feature: 'auth',
    };

    await executeDispatch(params, CWD, EXTENSION_DIR);

    // writeStateFile was called — state.md would now exist on disk
    expect(writeStateFile).toHaveBeenCalled();
    const initCall = vi.mocked(writeStateFile).mock.calls[0];
    const initState = initCall[1] as FlowState;
    expect(initState.feature).toBe('auth');
    expect(initState.budget).toBeDefined();

    // Simulate persistence: next readStateFile returns the written state
    const writtenState = initState;
    vi.mocked(readStateFile).mockReturnValue(writtenState);
    vi.clearAllMocks();
    callOrder = [];

    // Re-wire order tracking after clearAllMocks
    vi.mocked(ensureFeatureDir).mockImplementation((_cwd, _feature) => {
      callOrder.push('ensureFeatureDir');
      return '';
    });
    vi.mocked(writeStateFile).mockImplementation(() => {
      callOrder.push('writeStateFile');
    });
    vi.mocked(checkPhaseGate).mockImplementation(() => {
      callOrder.push('checkPhaseGate');
      return { canAdvance: true, reason: 'ok' };
    });
    vi.mocked(discoverAgents).mockImplementation(() => {
      callOrder.push('discoverAgents');
      return [builder, scout];
    });
    vi.mocked(spawnAgentWithRetry).mockImplementation(async () => {
      callOrder.push('spawnAgentWithRetry');
      return makeResult();
    });
    vi.mocked(writeCheckpoint).mockImplementation(() => {
      callOrder.push('writeCheckpoint');
    });
    vi.mocked(appendProgressLog).mockImplementation(() => {
      callOrder.push('appendProgressLog');
    });
    vi.mocked(loadConfig).mockReturnValue(makeConfig());
    vi.mocked(buildVariableMap).mockReturnValue({ FEATURE_NAME: 'auth' });
    vi.mocked(writeDispatchLog).mockReturnValue(undefined);

    await executeDispatch(params, CWD, EXTENSION_DIR);

    // Second dispatch skips re-init: ensureFeatureDir NOT called
    expect(callOrder).not.toContain('ensureFeatureDir');
    // But still dispatches the agent normally
    expect(callOrder).toContain('spawnAgentWithRetry');
  });

  it('(f) readCheckpoint is present in the index.ts import list', () => {
    const grep = execSync('grep -n "readCheckpoint" /Users/josorio/Code/pi-flow/src/index.ts', {
      encoding: 'utf8',
    });
    // Must appear on an import line
    const importLine = grep.split('\n').find((l) => l.includes('import'));
    expect(importLine).toBeDefined();
    expect(importLine).toContain('readCheckpoint');
  });

  // ─── WARN-1: markTaskComplete substring collision ────────────────────────

  describe('markTaskComplete substring collision (WARN-1)', () => {
    it('marking task-1.1 does not corrupt task-1.10 when only task-1.10 exists', async () => {
      // Bug: content.includes('- [ ] task-1.1') returns true even for task-1.10
      // because '- [ ] task-1.1' is a substring of '- [ ] task-1.10'.
      // Without the word-boundary fix, the replace corrupts task-1.10.
      vi.mocked(readStateFile).mockReturnValue(makeFlowState());
      vi.mocked(checkPhaseGate).mockReturnValue({ canAdvance: true, reason: 'ok' });
      vi.mocked(spawnAgentWithRetry).mockResolvedValue(
        makeResult({ task: 'implement task-1.1', exitCode: 0 }),
      );
      vi.mocked(fs.existsSync).mockReturnValue(true);
      // Only task-1.10 exists — task-1.1 is NOT present
      vi.mocked(fs.readFileSync).mockReturnValue('- [ ] task-1.10\n- [ ] task-1.2\n');

      const params: DispatchParams = {
        agent: 'builder',
        task: 'implement task-1.1',
        phase: 'execute',
        feature: 'auth',
      };

      await executeDispatch(params, CWD, EXTENSION_DIR);

      // task-1.1 is absent → writeFileSync should NOT be called (no-op)
      // If it IS called, the written content must not corrupt task-1.10
      if (vi.mocked(fs.writeFileSync).mock.calls.length > 0) {
        const writtenContent = vi.mocked(fs.writeFileSync).mock.calls[0][1] as string;
        expect(writtenContent).not.toContain('- [x] task-1.10');
        expect(writtenContent).toContain('- [ ] task-1.10');
      } else {
        // Preferred: no write at all (correct no-op behaviour)
        expect(fs.writeFileSync).not.toHaveBeenCalled();
      }
    });

    it('marking task-1.1 complete does not affect task-1.10 when both exist', async () => {
      vi.mocked(readStateFile).mockReturnValue(makeFlowState());
      vi.mocked(checkPhaseGate).mockReturnValue({ canAdvance: true, reason: 'ok' });
      vi.mocked(spawnAgentWithRetry).mockResolvedValue(
        makeResult({ task: 'implement task-1.1', exitCode: 0 }),
      );
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue('- [ ] task-1.1\n- [ ] task-1.10\n');

      const params: DispatchParams = {
        agent: 'builder',
        task: 'implement task-1.1',
        phase: 'execute',
        feature: 'auth',
      };

      await executeDispatch(params, CWD, EXTENSION_DIR);

      expect(fs.writeFileSync).toHaveBeenCalled();
      const writtenContent = vi.mocked(fs.writeFileSync).mock.calls[0][1] as string;
      expect(writtenContent).toContain('- [x] task-1.1\n');
      expect(writtenContent).toContain('- [ ] task-1.10');
    });
  });

  // ─── WARN-2: Init writeStateFile not try-caught ──────────────────────────

  describe('state init error resilience (WARN-2)', () => {
    it('first dispatch: writeStateFile throwing during init does not propagate as isError', async () => {
      vi.mocked(readStateFile).mockReturnValue(null);
      vi.mocked(writeStateFile).mockImplementationOnce(() => {
        throw new Error('disk full on init');
      });
      vi.mocked(spawnAgentWithRetry).mockResolvedValue(makeResult());

      const params: DispatchParams = {
        agent: 'builder',
        task: 'implement task-1.1',
        phase: 'execute',
        feature: 'auth',
      };

      const result = await executeDispatch(params, CWD, EXTENSION_DIR);

      expect(result.isError).toBeUndefined();
      expect(result.content[0].text).toBeTruthy();
    });
  });
});
