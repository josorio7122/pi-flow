/**
 * background.ts — Background agent execution manager with concurrency control.
 *
 * Tracks running/queued agents, auto-drains queue on completion,
 * and groups parallel completion notifications.
 *
 * Adopted from tintinweb/pi-subagents' AgentManager + GroupJoinManager.
 */

import { randomUUID } from 'node:crypto';
import type { FlowAgentConfig, SingleAgentResult, UsageStats } from './types.js';

// ─── Types ────────────────────────────────────────────────────────────────────

export type AgentStatus = 'queued' | 'running' | 'completed' | 'steered' | 'aborted' | 'error';

export interface BackgroundRecord {
  id: string;
  agent: FlowAgentConfig;
  task: string;
  description: string;
  feature?: string;
  status: AgentStatus;
  result?: SingleAgentResult;
  error?: string;
  startedAt: number;
  completedAt?: number;
  abortController: AbortController;
  promise?: Promise<SingleAgentResult>;
  usage?: UsageStats;
  /** Number of tool uses completed by this agent. */
  toolUses?: number;
  /** True if result was already consumed via get_agent_result — suppresses notification. */
  resultConsumed?: boolean;
  /** Steering messages queued before the session is ready. */
  pendingSteers?: string[];
  /** Callback to deliver a steer to the live session. */
  steerFn?: (message: string) => Promise<void>;
  /** Reference to the live agent session (for resume, stats, conversation). */
  session?: unknown;
  /** The tool_use_id from the original dispatch tool call. */
  toolCallId?: string;
  /** Path to the streaming output transcript file. */
  outputFile?: string;
  /** Cleanup function for the output file stream subscription. */
  outputCleanup?: () => void;
  /** Group ID for batched notifications. */
  groupId?: string;
  /** Join mode for notification batching. */
  joinMode?: 'async' | 'group' | 'smart';
  /** Worktree info if the agent is running in isolation. */
  worktreeInfo?: { path: string; branch: string };
  /** Worktree cleanup result after completion. */
  worktreeResult?: { hasChanges: boolean; branch?: string };
}

export interface SpawnOptions {
  agent: FlowAgentConfig;
  task: string;
  description: string;
  feature?: string;
  /** The function that actually runs the agent — injected by dispatch. */
  executor: (signal: AbortSignal) => Promise<SingleAgentResult>;
}

export interface BackgroundManagerOptions {
  onComplete?: (record: BackgroundRecord) => void;
  onStart?: (record: BackgroundRecord) => void;
  maxConcurrent?: number;
}

// ─── BackgroundManager ────────────────────────────────────────────────────────

const DEFAULT_MAX_CONCURRENT = 4;

export class BackgroundManager {
  private agents = new Map<string, BackgroundRecord>();
  private queue: { id: string; options: SpawnOptions }[] = [];
  private runningCount = 0;
  private maxConcurrent: number;
  private onComplete?: (record: BackgroundRecord) => void;
  private onStart?: (record: BackgroundRecord) => void;
  private cleanupInterval: ReturnType<typeof setInterval>;

  constructor(opts: BackgroundManagerOptions = {}) {
    this.onComplete = opts.onComplete;
    this.onStart = opts.onStart;
    this.maxConcurrent = opts.maxConcurrent ?? DEFAULT_MAX_CONCURRENT;
    // Auto-cleanup completed agents after 10 minutes
    this.cleanupInterval = setInterval(() => this.autoCleanup(), 60_000);
  }

  private autoCleanup(): void {
    const cutoff = Date.now() - 10 * 60_000;
    for (const [id, record] of this.agents) {
      if (record.status === 'running' || record.status === 'queued') continue;
      if ((record.completedAt ?? 0) >= cutoff) continue;
      this.agents.delete(id);
    }
  }

  /** Update the max concurrent background agents limit. */
  setMaxConcurrent(n: number): void {
    this.maxConcurrent = Math.max(1, n);
    this.drainQueue();
  }

  getMaxConcurrent(): number {
    return this.maxConcurrent;
  }

  /** Increment tool use counter for an agent. */
  incrementToolUses(id: string): void {
    const record = this.agents.get(id);
    if (record) record.toolUses = (record.toolUses ?? 0) + 1;
  }

  /**
   * Spawn a background agent. Returns ID immediately.
   * If concurrency limit reached, agent is queued.
   */
  spawn(options: SpawnOptions): string {
    const id = randomUUID().slice(0, 17);
    const abortController = new AbortController();

    const record: BackgroundRecord = {
      id,
      agent: options.agent,
      task: options.task,
      description: options.description,
      feature: options.feature,
      status: 'queued',
      startedAt: Date.now(),
      abortController,
    };
    this.agents.set(id, record);

    if (this.runningCount >= this.maxConcurrent) {
      this.queue.push({ id, options });
      return id;
    }

    this.startAgent(id, record, options);
    return id;
  }

  /**
   * Spawn and wait for completion (foreground path).
   * Bypasses the queue — always starts immediately.
   */
  async spawnAndWait(options: SpawnOptions): Promise<BackgroundRecord> {
    const id = randomUUID().slice(0, 17);
    const abortController = new AbortController();

    const record: BackgroundRecord = {
      id,
      agent: options.agent,
      task: options.task,
      description: options.description,
      feature: options.feature,
      status: 'running',
      startedAt: Date.now(),
      abortController,
    };
    this.agents.set(id, record);

    const promise = options.executor(abortController.signal);
    record.promise = promise;

    try {
      const result = await promise;
      record.status = result.exitCode === 0 ? 'completed' : 'error';
      record.result = result;
      record.usage = result.usage;
      record.completedAt = Date.now();
    } catch (err) {
      record.status = 'error';
      record.error = err instanceof Error ? err.message : String(err);
      record.completedAt = Date.now();
    }

    return record;
  }

  // ── Status ────────────────────────────────────────────────────────────────

  getRecord(id: string): BackgroundRecord | undefined {
    return this.agents.get(id);
  }

  listAgents(): BackgroundRecord[] {
    return [...this.agents.values()];
  }

  hasRunning(): boolean {
    for (const r of this.agents.values()) {
      if (r.status === 'running' || r.status === 'queued') return true;
    }
    return false;
  }

  /**
   * Wait for all running and queued agents to complete.
   * Loops because drainQueue starts new agents as running ones finish.
   */
  async waitForAll(): Promise<void> {
    while (true) {
      this.drainQueue();
      const pending = [...this.agents.values()]
        .filter((r) => r.status === 'running' || r.status === 'queued')
        .map((r) => r.promise)
        .filter(Boolean);
      if (pending.length === 0) break;
      await Promise.allSettled(pending);
    }
  }

  // ── Control ───────────────────────────────────────────────────────────────

  abort(id: string): void {
    const record = this.agents.get(id);
    if (!record) return;
    if (record.status === 'running' || record.status === 'queued') {
      record.abortController.abort();
      record.status = 'aborted';
      record.completedAt = Date.now();
      if (record.status === 'aborted' && this.runningCount > 0) {
        this.runningCount--;
        this.drainQueue();
      }
    }
  }

  abortAll(): void {
    for (const record of this.agents.values()) {
      if (record.status === 'running' || record.status === 'queued') {
        record.abortController.abort();
        record.status = 'aborted';
        record.completedAt = Date.now();
      }
    }
    this.runningCount = 0;
    this.queue = [];
  }

  steer(id: string, message: string): void {
    const record = this.agents.get(id);
    if (!record) return;

    if (record.steerFn) {
      record.steerFn(message).catch(() => {});
    } else {
      if (!record.pendingSteers) record.pendingSteers = [];
      record.pendingSteers.push(message);
    }
  }

  /**
   * Flush any pending steers for an agent.
   * Called when the session becomes available (onSessionCreated).
   */
  flushPendingSteers(id: string): void {
    const record = this.agents.get(id);
    if (!record?.steerFn || !record.pendingSteers?.length) return;
    for (const msg of record.pendingSteers) {
      record.steerFn(msg).catch(() => {});
    }
    record.pendingSteers = undefined;
  }

  // ── Cleanup ───────────────────────────────────────────────────────────────

  clearCompleted(): void {
    for (const [id, record] of this.agents) {
      if (record.status !== 'running' && record.status !== 'queued') {
        this.agents.delete(id);
      }
    }
  }

  dispose(): void {
    clearInterval(this.cleanupInterval);
    this.abortAll();
    this.agents.clear();
    this.queue = [];
  }

  // ── Internal ──────────────────────────────────────────────────────────────

  private startAgent(_: string, record: BackgroundRecord, options: SpawnOptions): void {
    record.status = 'running';
    record.startedAt = Date.now();
    this.runningCount++;
    this.onStart?.(record);

    const promise = options
      .executor(record.abortController.signal)
      .then((result) => {
        if (record.status !== 'aborted') {
          record.status = result.exitCode === 0 ? 'completed' : 'error';
        }
        record.result = result;
        record.usage = result.usage;
        record.completedAt = Date.now();
        // Final flush of output transcript
        if (record.outputCleanup) {
          try {
            record.outputCleanup();
          } catch {
            /* ignore */
          }
          record.outputCleanup = undefined;
        }
        this.runningCount--;
        this.onComplete?.(record);
        this.drainQueue();
        return result;
      })
      .catch((err) => {
        if (record.status !== 'aborted') {
          record.status = 'error';
          record.error = err instanceof Error ? err.message : String(err);
        }
        record.completedAt = Date.now();
        if (record.outputCleanup) {
          try {
            record.outputCleanup();
          } catch {
            /* ignore */
          }
          record.outputCleanup = undefined;
        }
        this.runningCount--;
        this.onComplete?.(record);
        this.drainQueue();
        return {
          agent: record.agent.name,
          agentSource: record.agent.source,
          task: record.task,
          exitCode: 1,
          messages: [],
          stderr: record.error ?? '',
          usage: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            cost: 0,
            contextTokens: 0,
            turns: 0,
          },
          startedAt: record.startedAt,
        } as SingleAgentResult;
      });

    record.promise = promise;
  }

  private drainQueue(): void {
    while (this.queue.length > 0 && this.runningCount < this.maxConcurrent) {
      const next = this.queue.shift()!;
      const record = this.agents.get(next.id);
      if (record && record.status === 'queued') {
        this.startAgent(next.id, record, next.options);
      }
    }
  }
}

// ─── GroupJoinManager ─────────────────────────────────────────────────────────

export type DeliveryCallback = (results: SingleAgentResult[], partial: boolean) => void;

interface AgentGroup {
  groupId: string;
  agentIds: Set<string>;
  completedResults: Map<string, SingleAgentResult>;
  timeoutHandle?: ReturnType<typeof setTimeout>;
  delivered: boolean;
  isStraggler: boolean;
}

const DEFAULT_TIMEOUT = 30_000;
const STRAGGLER_TIMEOUT = 15_000;

export class GroupJoinManager {
  private groups = new Map<string, AgentGroup>();
  private agentToGroup = new Map<string, string>();

  constructor(
    private deliverCb: DeliveryCallback,
    private groupTimeout = DEFAULT_TIMEOUT,
  ) {}

  registerGroup(groupId: string, agentIds: string[]): void {
    const group: AgentGroup = {
      groupId,
      agentIds: new Set(agentIds),
      completedResults: new Map(),
      delivered: false,
      isStraggler: false,
    };
    this.groups.set(groupId, group);
    for (const id of agentIds) {
      this.agentToGroup.set(id, groupId);
    }
  }

  /**
   * Called when an agent completes.
   * - 'pass'      — agent is not grouped
   * - 'held'      — result held, waiting for group
   * - 'delivered'  — this completion triggered group delivery
   */
  onAgentComplete(agentId: string, result: SingleAgentResult): 'delivered' | 'held' | 'pass' {
    const groupId = this.agentToGroup.get(agentId);
    if (!groupId) return 'pass';

    const group = this.groups.get(groupId);
    if (!group || group.delivered) return 'pass';

    group.completedResults.set(agentId, result);

    // All done — deliver immediately
    if (group.completedResults.size >= group.agentIds.size) {
      this.deliver(group, false);
      return 'delivered';
    }

    // First completion — start timeout
    if (!group.timeoutHandle) {
      const timeout = group.isStraggler ? STRAGGLER_TIMEOUT : this.groupTimeout;
      group.timeoutHandle = setTimeout(() => this.onTimeout(group), timeout);
    }

    return 'held';
  }

  isGrouped(agentId: string): boolean {
    return this.agentToGroup.has(agentId);
  }

  dispose(): void {
    for (const group of this.groups.values()) {
      if (group.timeoutHandle) clearTimeout(group.timeoutHandle);
    }
    this.groups.clear();
    this.agentToGroup.clear();
  }

  // ── Internal ──────────────────────────────────────────────────────────────

  private onTimeout(group: AgentGroup): void {
    if (group.delivered) return;
    group.timeoutHandle = undefined;

    // Clean up delivered agents
    for (const id of group.completedResults.keys()) {
      this.agentToGroup.delete(id);
    }

    // Partial delivery
    this.deliverCb([...group.completedResults.values()], true);

    // Set up straggler tracking for remaining agents
    const remaining = new Set<string>();
    for (const id of group.agentIds) {
      if (!group.completedResults.has(id)) remaining.add(id);
    }
    group.completedResults.clear();
    group.agentIds = remaining;
    group.isStraggler = true;
  }

  private deliver(group: AgentGroup, partial: boolean): void {
    if (group.timeoutHandle) {
      clearTimeout(group.timeoutHandle);
      group.timeoutHandle = undefined;
    }
    group.delivered = true;
    this.deliverCb([...group.completedResults.values()], partial);
    this.cleanupGroup(group.groupId);
  }

  private cleanupGroup(groupId: string): void {
    const group = this.groups.get(groupId);
    if (!group) return;
    for (const id of group.agentIds) {
      this.agentToGroup.delete(id);
    }
    this.groups.delete(groupId);
  }
}
