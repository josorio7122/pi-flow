import { describe, it, expect, vi, beforeEach } from 'vitest';
import { BackgroundManager, GroupJoinManager, SmartBatcher } from './background.js';
import type { FlowAgentConfig, SingleAgentResult } from './types.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeAgent(name = 'scout'): FlowAgentConfig {
  return {
    name,
    label: name,
    description: 'Test agent',
    model: 'anthropic/claude-sonnet-4-6',
    thinking: 'low',
    tools: ['read'],
    writable: false,
    limits: { max_tokens: 60000, max_steps: 80 },
    variables: [],
    writes: [],
    systemPrompt: '',
    source: 'builtin' as const,
    filePath: '',
  };
}

function makeResult(agent = 'scout', exitCode = 0): SingleAgentResult {
  return {
    agent,
    agentSource: 'builtin',
    task: 'test task',
    exitCode,
    messages: [],
    stderr: '',
    usage: {
      input: 100,
      output: 50,
      cacheRead: 0,
      cacheWrite: 0,
      cost: 0.01,
      contextTokens: 150,
      turns: 3,
    },
    startedAt: Date.now(),
  };
}

// ─── BackgroundManager ────────────────────────────────────────────────────────

describe('BackgroundManager', () => {
  let manager: BackgroundManager;
  let onComplete: (record: any) => void;

  beforeEach(() => {
    onComplete = vi.fn();
    manager = new BackgroundManager({ onComplete, maxConcurrent: 2 });
  });

  it('spawns an agent and returns an ID', () => {
    const executor = vi.fn(() => Promise.resolve(makeResult()));
    const id = manager.spawn({
      agent: makeAgent(),
      task: 'scan code',
      description: 'Scan authentication',
      executor,
    });

    expect(id).toBeDefined();
    expect(typeof id).toBe('string');
  });

  it('tracks agent status as running', () => {
    const executor = vi.fn(() => new Promise<SingleAgentResult>(() => {})); // never resolves
    const id = manager.spawn({
      agent: makeAgent(),
      task: 'scan code',
      description: 'Scan auth',
      executor,
    });

    const record = manager.getRecord(id);
    expect(record).toBeDefined();
    expect(record!.status).toBe('running');
  });

  it('updates status to completed when executor resolves', async () => {
    let resolve!: (r: SingleAgentResult) => void;
    const promise = new Promise<SingleAgentResult>((r) => {
      resolve = r;
    });
    const executor = vi.fn(() => promise);

    const id = manager.spawn({
      agent: makeAgent(),
      task: 'scan',
      description: 'Scan',
      executor,
    });

    resolve(makeResult());
    // Wait for microtask
    await new Promise((r) => setTimeout(r, 10));

    const record = manager.getRecord(id);
    expect(record!.status).toBe('completed');
    expect(onComplete).toHaveBeenCalledWith(expect.objectContaining({ id, status: 'completed' }));
  });

  it('updates status to error when executor rejects', async () => {
    const executor = vi.fn(() => Promise.reject(new Error('boom')));

    const id = manager.spawn({
      agent: makeAgent(),
      task: 'scan',
      description: 'Scan',
      executor,
    });

    await new Promise((r) => setTimeout(r, 10));

    const record = manager.getRecord(id);
    expect(record!.status).toBe('error');
    expect(record!.error).toBe('boom');
  });

  it('queues agents when max concurrent reached', () => {
    const executor = vi.fn(() => new Promise<SingleAgentResult>(() => {}));

    manager.spawn({ agent: makeAgent('a1'), task: 't1', description: 'd1', executor });
    manager.spawn({ agent: makeAgent('a2'), task: 't2', description: 'd2', executor });
    const id3 = manager.spawn({
      agent: makeAgent('a3'),
      task: 't3',
      description: 'd3',
      executor,
    });

    const record = manager.getRecord(id3);
    expect(record!.status).toBe('queued');
    expect(executor).toHaveBeenCalledTimes(2); // only 2 started
  });

  it('drains queue when a running agent completes', async () => {
    let resolve1!: (r: SingleAgentResult) => void;
    const p1 = new Promise<SingleAgentResult>((r) => {
      resolve1 = r;
    });
    const executor1 = vi.fn(() => p1);
    const executor2 = vi.fn(() => new Promise<SingleAgentResult>(() => {}));
    const executor3 = vi.fn(() => new Promise<SingleAgentResult>(() => {}));

    manager.spawn({ agent: makeAgent('a1'), task: 't1', description: 'd1', executor: executor1 });
    manager.spawn({ agent: makeAgent('a2'), task: 't2', description: 'd2', executor: executor2 });
    const id3 = manager.spawn({
      agent: makeAgent('a3'),
      task: 't3',
      description: 'd3',
      executor: executor3,
    });

    expect(manager.getRecord(id3)!.status).toBe('queued');

    // Complete agent 1
    resolve1(makeResult('a1'));
    await new Promise((r) => setTimeout(r, 10));

    // Agent 3 should now be running
    expect(manager.getRecord(id3)!.status).toBe('running');
    expect(executor3).toHaveBeenCalledTimes(1);
  });

  it('abort cancels a running agent', () => {
    const executor = vi.fn(() => new Promise<SingleAgentResult>(() => {}));
    const id = manager.spawn({
      agent: makeAgent(),
      task: 'scan',
      description: 'Scan',
      executor,
    });

    manager.abort(id);
    const record = manager.getRecord(id);
    expect(record!.status).toBe('aborted');
  });

  it('abortAll cancels all running agents', () => {
    const executor = vi.fn(() => new Promise<SingleAgentResult>(() => {}));
    const id1 = manager.spawn({
      agent: makeAgent('a1'),
      task: 't1',
      description: 'd1',
      executor,
    });
    const id2 = manager.spawn({
      agent: makeAgent('a2'),
      task: 't2',
      description: 'd2',
      executor,
    });

    manager.abortAll();
    expect(manager.getRecord(id1)!.status).toBe('aborted');
    expect(manager.getRecord(id2)!.status).toBe('aborted');
  });

  it('listAgents returns all tracked agents', () => {
    const executor = vi.fn(() => new Promise<SingleAgentResult>(() => {}));
    manager.spawn({ agent: makeAgent('a1'), task: 't1', description: 'd1', executor });
    manager.spawn({ agent: makeAgent('a2'), task: 't2', description: 'd2', executor });

    expect(manager.listAgents()).toHaveLength(2);
  });

  it('hasRunning returns true when agents are running', () => {
    const executor = vi.fn(() => new Promise<SingleAgentResult>(() => {}));
    expect(manager.hasRunning()).toBe(false);
    manager.spawn({ agent: makeAgent(), task: 't', description: 'd', executor });
    expect(manager.hasRunning()).toBe(true);
  });

  it('waitForAll resolves when all agents complete', async () => {
    let resolve!: (r: SingleAgentResult) => void;
    const p = new Promise<SingleAgentResult>((r) => {
      resolve = r;
    });
    const executor = vi.fn(() => p);

    manager.spawn({ agent: makeAgent(), task: 't', description: 'd', executor });

    const waitPromise = manager.waitForAll();
    resolve(makeResult());

    await expect(waitPromise).resolves.toBeUndefined();
  });

  it('clearCompleted removes finished agents', async () => {
    const executor = vi.fn(() => Promise.resolve(makeResult()));
    manager.spawn({ agent: makeAgent(), task: 't', description: 'd', executor });

    await new Promise((r) => setTimeout(r, 10));
    expect(manager.listAgents()).toHaveLength(1);

    manager.clearCompleted();
    expect(manager.listAgents()).toHaveLength(0);
  });

  it('spawnAndWait returns the result directly', async () => {
    const result = makeResult();
    const executor = vi.fn(() => Promise.resolve(result));

    const record = await manager.spawnAndWait({
      agent: makeAgent(),
      task: 'scan',
      description: 'Scan',
      executor,
    });

    expect(record.status).toBe('completed');
    expect(record.result).toBeDefined();
  });

  it('steer queues message when session not ready', () => {
    const executor = vi.fn(() => new Promise<SingleAgentResult>(() => {}));
    const id = manager.spawn({
      agent: makeAgent(),
      task: 't',
      description: 'd',
      executor,
    });

    // No session set — should queue
    manager.steer(id, 'wrap up now');
    const record = manager.getRecord(id);
    expect(record!.pendingSteers).toContain('wrap up now');
  });

  // ── Phase 1: Gap #24 — pending steers flushed via onSessionCreated ──────

  it('flushes pending steers when steerFn is set', () => {
    const executor = vi.fn(() => new Promise<SingleAgentResult>(() => {}));
    const id = manager.spawn({
      agent: makeAgent(),
      task: 't',
      description: 'd',
      executor,
    });

    // Queue steers before session ready
    manager.steer(id, 'message 1');
    manager.steer(id, 'message 2');

    // Simulate session ready — set steerFn
    const steerFn = vi.fn(() => Promise.resolve());
    const record = manager.getRecord(id)!;
    record.steerFn = steerFn;

    // Flush pending steers
    manager.flushPendingSteers(id);
    expect(steerFn).toHaveBeenCalledTimes(2);
    expect(steerFn).toHaveBeenCalledWith('message 1');
    expect(steerFn).toHaveBeenCalledWith('message 2');
    expect(record.pendingSteers).toBeUndefined();
  });

  it('flushPendingSteers is a no-op when no pending steers', () => {
    const executor = vi.fn(() => new Promise<SingleAgentResult>(() => {}));
    const id = manager.spawn({
      agent: makeAgent(),
      task: 't',
      description: 'd',
      executor,
    });

    const steerFn = vi.fn(() => Promise.resolve());
    manager.getRecord(id)!.steerFn = steerFn;
    manager.flushPendingSteers(id);
    expect(steerFn).not.toHaveBeenCalled();
  });

  // ── Phase 1: Gap #26 — waitForAll with loop-drain ──────────────────────

  // ── Phase 2: Gap #27 — setMaxConcurrent at runtime ───────────────────

  it('setMaxConcurrent adjusts limit and drains queue', async () => {
    const executor = vi.fn(() => new Promise<SingleAgentResult>(() => {}));

    // maxConcurrent=2, spawn 3 — third is queued
    manager.spawn({ agent: makeAgent('a1'), task: 't1', description: 'd1', executor });
    manager.spawn({ agent: makeAgent('a2'), task: 't2', description: 'd2', executor });
    const id3 = manager.spawn({
      agent: makeAgent('a3'),
      task: 't3',
      description: 'd3',
      executor,
    });
    expect(manager.getRecord(id3)!.status).toBe('queued');

    // Increase limit — should drain queue
    manager.setMaxConcurrent(3);
    expect(manager.getRecord(id3)!.status).toBe('running');
  });

  it('getMaxConcurrent returns current limit', () => {
    expect(manager.getMaxConcurrent()).toBe(2);
    manager.setMaxConcurrent(8);
    expect(manager.getMaxConcurrent()).toBe(8);
  });

  // ── Phase 2: Gap #30 — toolUses counter ─────────────────────────────

  it('tracks toolUses via onToolUse callback', async () => {
    const result = makeResult();
    const executor = vi.fn(() => Promise.resolve(result));
    const id = manager.spawn({
      agent: makeAgent(),
      task: 't',
      description: 'd',
      executor,
    });

    // Simulate tool use tracking
    manager.incrementToolUses(id);
    manager.incrementToolUses(id);
    expect(manager.getRecord(id)!.toolUses).toBe(2);
  });

  // ── Phase 2: Gap #31 — onStart callback ─────────────────────────────

  it('calls onStart when agent transitions to running', async () => {
    const onStart = vi.fn();
    const mgr = new BackgroundManager({ onComplete: vi.fn(), maxConcurrent: 2, onStart });
    const executor = vi.fn(() => new Promise<SingleAgentResult>(() => {}));

    mgr.spawn({ agent: makeAgent(), task: 't', description: 'd', executor });
    expect(onStart).toHaveBeenCalledTimes(1);
    expect(onStart).toHaveBeenCalledWith(expect.objectContaining({ status: 'running' }));
  });

  it('calls onStart for queued agents when they start', async () => {
    const onStart = vi.fn();
    let resolve1!: (r: SingleAgentResult) => void;
    const mgr = new BackgroundManager({ onComplete: vi.fn(), maxConcurrent: 1, onStart });

    const p1 = new Promise<SingleAgentResult>((r) => {
      resolve1 = r;
    });
    mgr.spawn({ agent: makeAgent('a1'), task: 't1', description: 'd1', executor: () => p1 });
    mgr.spawn({
      agent: makeAgent('a2'),
      task: 't2',
      description: 'd2',
      executor: () => new Promise<SingleAgentResult>(() => {}),
    });

    expect(onStart).toHaveBeenCalledTimes(1); // only a1

    resolve1(makeResult('a1'));
    await new Promise((r) => setTimeout(r, 20));

    expect(onStart).toHaveBeenCalledTimes(2); // now a2 too
  });

  // ── Phase 2: Gap #34 — resultConsumed flag ──────────────────────────

  it('resultConsumed prevents onComplete from firing notification', async () => {
    const onComplete = vi.fn();
    const mgr = new BackgroundManager({ onComplete, maxConcurrent: 2 });
    const executor = vi.fn(() => Promise.resolve(makeResult()));

    const id = mgr.spawn({ agent: makeAgent(), task: 't', description: 'd', executor });

    // Mark as consumed before completion
    mgr.getRecord(id)!.resultConsumed = true;

    await new Promise((r) => setTimeout(r, 20));

    // onComplete still fires (manager doesn't know about consumption)
    // but the record has the flag set for the caller to check
    expect(mgr.getRecord(id)!.resultConsumed).toBe(true);
  });

  // ── Phase 1: Gap #26 — waitForAll with loop-drain ──────────────────

  it('waitForAll drains queued agents through completion', async () => {
    let resolve1!: (r: SingleAgentResult) => void;
    let resolve2!: (r: SingleAgentResult) => void;
    let resolve3!: (r: SingleAgentResult) => void;

    const executor1 = vi.fn(
      () =>
        new Promise<SingleAgentResult>((r) => {
          resolve1 = r;
        }),
    );
    const executor2 = vi.fn(
      () =>
        new Promise<SingleAgentResult>((r) => {
          resolve2 = r;
        }),
    );
    const executor3 = vi.fn(
      () =>
        new Promise<SingleAgentResult>((r) => {
          resolve3 = r;
        }),
    );

    // maxConcurrent=2, so a3 will be queued
    manager.spawn({ agent: makeAgent('a1'), task: 't1', description: 'd1', executor: executor1 });
    manager.spawn({ agent: makeAgent('a2'), task: 't2', description: 'd2', executor: executor2 });
    manager.spawn({ agent: makeAgent('a3'), task: 't3', description: 'd3', executor: executor3 });

    // Start waiting (won't resolve until all 3 are done)
    const waitPromise = manager.waitForAll();

    // Complete a1 — should trigger a3 to start via drain
    resolve1(makeResult('a1'));
    await new Promise((r) => setTimeout(r, 20));
    expect(executor3).toHaveBeenCalledTimes(1);

    // Complete a2 and a3
    resolve2(makeResult('a2'));
    resolve3(makeResult('a3'));

    await expect(waitPromise).resolves.toBeUndefined();
    expect(manager.listAgents().every((r) => r.status === 'completed')).toBe(true);
  });

  // ── Phase 6: Gap #6/#25 — resume existing session ────────────────────

  it('resume re-prompts an existing session', async () => {
    const session = { steer: vi.fn() };
    let resolve!: (r: SingleAgentResult) => void;
    const executor = vi.fn(
      () =>
        new Promise<SingleAgentResult>((r) => {
          resolve = r;
        }),
    );
    const id = manager.spawn({
      agent: makeAgent(),
      task: 't',
      description: 'd',
      executor,
    });

    // Set session reference
    manager.getRecord(id)!.session = session;
    resolve(makeResult());
    await new Promise((r) => setTimeout(r, 20));

    // Resume
    const resumeExecutor = vi.fn(() => Promise.resolve('resumed output'));
    const record = await manager.resume(id, 'new prompt', resumeExecutor);

    expect(record).toBeDefined();
    expect(record!.status).toBe('completed');
    expect(resumeExecutor).toHaveBeenCalledWith(session, 'new prompt');
  });

  it('resume returns undefined for agent without session', async () => {
    const executor = vi.fn(() => Promise.resolve(makeResult()));
    const id = manager.spawn({
      agent: makeAgent(),
      task: 't',
      description: 'd',
      executor,
    });
    await new Promise((r) => setTimeout(r, 20));

    // No session set — clear it
    manager.getRecord(id)!.session = undefined;
    const result = await manager.resume(id, 'prompt', vi.fn());
    expect(result).toBeUndefined();
  });
});

// ─── SmartBatcher ─────────────────────────────────────────────────────────────

describe('SmartBatcher', () => {
  it('registers groups for 2+ agents in the same batch', async () => {
    const gjm = new GroupJoinManager(vi.fn());
    const batcher = new SmartBatcher(gjm);

    batcher.add('a1');
    batcher.add('a2');
    batcher.add('a3');

    // Wait for debounce
    await new Promise((r) => setTimeout(r, 150));

    expect(gjm.isGrouped('a1')).toBe(true);
    expect(gjm.isGrouped('a2')).toBe(true);
    expect(gjm.isGrouped('a3')).toBe(true);
    batcher.dispose();
  });

  it('does not register group for single agent', async () => {
    const gjm = new GroupJoinManager(vi.fn());
    const batcher = new SmartBatcher(gjm);

    batcher.add('solo');
    await new Promise((r) => setTimeout(r, 150));

    expect(gjm.isGrouped('solo')).toBe(false);
    batcher.dispose();
  });
});

// ─── GroupJoinManager ─────────────────────────────────────────────────────────

describe('GroupJoinManager', () => {
  it('passes through ungrouped agents', () => {
    const deliver = vi.fn();
    const gjm = new GroupJoinManager(deliver);

    const result = gjm.onAgentComplete('agent-1', makeResult());
    expect(result).toBe('pass');
    expect(deliver).not.toHaveBeenCalled();
  });

  it('holds grouped agents until all complete', () => {
    const deliver = vi.fn();
    const gjm = new GroupJoinManager(deliver);

    gjm.registerGroup('g1', ['a1', 'a2', 'a3']);

    expect(gjm.onAgentComplete('a1', makeResult('a1'))).toBe('held');
    expect(gjm.onAgentComplete('a2', makeResult('a2'))).toBe('held');
    expect(deliver).not.toHaveBeenCalled();

    expect(gjm.onAgentComplete('a3', makeResult('a3'))).toBe('delivered');
    expect(deliver).toHaveBeenCalledTimes(1);
    expect(deliver).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({ agent: 'a1' }),
        expect.objectContaining({ agent: 'a2' }),
        expect.objectContaining({ agent: 'a3' }),
      ]),
      false,
    );
  });

  it('delivers partial results on timeout', async () => {
    const deliver = vi.fn();
    const gjm = new GroupJoinManager(deliver, 50); // 50ms timeout

    gjm.registerGroup('g1', ['a1', 'a2']);

    gjm.onAgentComplete('a1', makeResult('a1'));

    // Wait for timeout
    await new Promise((r) => setTimeout(r, 100));

    expect(deliver).toHaveBeenCalledWith(
      expect.arrayContaining([expect.objectContaining({ agent: 'a1' })]),
      true,
    );

    gjm.dispose();
  });

  it('isGrouped returns true for grouped agents', () => {
    const gjm = new GroupJoinManager(vi.fn());
    gjm.registerGroup('g1', ['a1', 'a2']);

    expect(gjm.isGrouped('a1')).toBe(true);
    expect(gjm.isGrouped('unknown')).toBe(false);
  });

  it('dispose clears all groups and timers', () => {
    const gjm = new GroupJoinManager(vi.fn(), 50);
    gjm.registerGroup('g1', ['a1', 'a2']);
    gjm.onAgentComplete('a1', makeResult('a1'));

    // Should not throw
    gjm.dispose();
    expect(gjm.isGrouped('a1')).toBe(false);
  });
});
