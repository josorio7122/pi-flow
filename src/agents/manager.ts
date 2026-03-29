/**
 * manager.ts — Tracks agents, background execution, resume support.
 *
 * Background agents are subject to a configurable concurrency limit (default: 4).
 * Excess agents are queued and auto-started as running agents complete.
 * Foreground agents bypass the queue (they block the parent anyway).
 */

import { randomUUID } from "node:crypto";
import { cleanupWorktree, createWorktree, pruneWorktrees } from "../infra/worktree.js";
import type { AgentRecord } from "../types.js";
import {
  DEFAULT_MAX_CONCURRENT,
  type OnAgentComplete,
  type OnAgentStart,
  type SpawnArgs,
  type SpawnOptions,
} from "./manager-types.js";
import type { Registry } from "./registry.js";
import { resumeAgent, runAgent } from "./runner.js";
import type { RunnerSettings, ToolActivity } from "./runner-types.js";

export function createAgentManager({
  onComplete,
  maxConcurrent: initMaxConcurrent = DEFAULT_MAX_CONCURRENT,
  onStart,
}: {
  onComplete?: OnAgentComplete | undefined;
  maxConcurrent?: number;
  onStart?: OnAgentStart | undefined;
} = {}) {
  const agents = new Map<string, AgentRecord>();

  let maxConcurrent = initMaxConcurrent;

  let queue: { id: string; args: SpawnArgs }[] = [];
  let runningBackground = 0;

  let settings: RunnerSettings | undefined;
  let registry: Registry | undefined;

  const cleanupInterval = setInterval(() => cleanup(), 60_000);

  function setRunnerSettings(s: RunnerSettings) {
    settings = s;
  }

  function setRegistry(r: Registry) {
    registry = r;
  }

  function setMaxConcurrent(n: number) {
    maxConcurrent = Math.max(1, n);
    // Start queued agents if the new limit allows
    drainQueue();
  }

  function getMaxConcurrent() {
    return maxConcurrent;
  }

  /**
   * Spawn an agent and return its ID immediately (for background use).
   * If the concurrency limit is reached, the agent is queued.
   */
  function spawn({ pi, ctx, type, prompt, options }: SpawnArgs) {
    const id = randomUUID().slice(0, 17);
    const abortController = new AbortController();
    const record: AgentRecord = {
      id,
      type,
      description: options.description,
      status: options.isBackground ? "queued" : "running",
      toolUses: 0,
      startedAt: Date.now(),
      abortController,
    };
    agents.set(id, record);

    const args: SpawnArgs = { pi, ctx, type, prompt, options };

    if (options.isBackground && runningBackground >= maxConcurrent) {
      // Queue it — will be started when a running agent completes
      queue.push({ id, args });
      return id;
    }

    startAgent({ id, record, args });
    return id;
  }

  function startAgent({ id, record, args }: { id: string; record: AgentRecord; args: SpawnArgs }) {
    const { pi, ctx, type, prompt, options } = args;
    record.status = "running";
    record.startedAt = Date.now();
    if (options.isBackground) runningBackground++;
    onStart?.(record);

    // Worktree isolation: create a temporary git worktree if requested
    let worktreeCwd: string | undefined;
    let worktreeWarning = "";
    if (options.isolation === "worktree") {
      const wt = createWorktree(ctx.cwd, id);
      if (wt) {
        record.worktree = wt;
        worktreeCwd = wt.path;
      } else {
        worktreeWarning =
          "\n\n[WARNING: Worktree isolation was requested but failed (not a git repo, or no commits yet). Running in the main working directory instead.]";
      }
    }

    // Prepend worktree warning to prompt if isolation failed
    const effectivePrompt = worktreeWarning ? worktreeWarning + "\n\n" + prompt : prompt;

    const promise = runAgent({
      ctx,
      type,
      prompt: effectivePrompt,
      options: {
        settings: settings,
        registry: registry,
        pi,
        model: options.model,
        maxTurns: options.maxTurns,
        isolated: options.isolated,
        inheritContext: options.inheritContext,
        thinkingLevel: options.thinkingLevel,
        cwd: worktreeCwd,
        signal: record.abortController!.signal,
        onToolActivity: (activity) => {
          if (activity.type === "end") record.toolUses++;
          options.onToolActivity?.(activity);
        },
        onTurnEnd: options.onTurnEnd,
        onTextDelta: options.onTextDelta,
        onSessionCreated: (session) => {
          record.session = session;
          // Flush any steers that arrived before the session was ready
          if (record.pendingSteers?.length) {
            for (const msg of record.pendingSteers) {
              session.steer(msg).catch(() => {});
            }
            record.pendingSteers = undefined;
          }
          options.onSessionCreated?.(session);
        },
      },
    })
      .then(({ responseText, session, aborted, steered }) => {
        if (record.status !== "stopped") {
          record.status = aborted ? "aborted" : steered ? "steered" : "completed";
        }
        record.result = responseText;
        record.session = session;
        finalizeAgent({ record, cwd: ctx.cwd, options });
        return responseText;
      })
      .catch((err) => {
        if (record.status !== "stopped") {
          record.status = "error";
        }
        record.error = err instanceof Error ? err.message : String(err);
        finalizeAgent({ record, cwd: ctx.cwd, options });
        return "";
      });

    record.promise = promise;
  }

  function finalizeAgent({ record, cwd, options }: { record: AgentRecord; cwd: string; options: SpawnOptions }) {
    record.completedAt ??= Date.now();

    if (record.outputCleanup) {
      try {
        record.outputCleanup();
      } catch {
        /* ignore */
      }
      record.outputCleanup = undefined;
    }

    if (record.worktree) {
      try {
        const wtResult = cleanupWorktree({ cwd, worktree: record.worktree, agentDescription: options.description });
        record.worktreeResult = wtResult;
        if (wtResult.hasChanges && wtResult.branch) {
          record.result =
            (record.result ?? "") +
            `\n\n---\nChanges saved to branch \`${wtResult.branch}\`. Merge with: \`git merge ${wtResult.branch}\``;
        }
      } catch {
        /* ignore cleanup errors */
      }
    }

    if (options.isBackground) {
      runningBackground--;
      onComplete?.(record);
      drainQueue();
    }
  }

  function drainQueue() {
    while (queue.length > 0 && runningBackground < maxConcurrent) {
      const next = queue.shift()!;
      const record = agents.get(next.id);
      if (!record || record.status !== "queued") continue;
      startAgent({ id: next.id, record, args: next.args });
    }
  }

  /**
   * Spawn an agent and wait for completion (foreground use).
   * Foreground agents bypass the concurrency queue.
   */
  async function spawnAndWait({
    pi,
    ctx,
    type,
    prompt,
    options,
  }: Omit<SpawnArgs, "options"> & { options: Omit<SpawnOptions, "isBackground"> }) {
    const id = spawn({ pi, ctx, type, prompt, options: { ...options, isBackground: false } });
    const record = agents.get(id)!;
    await record.promise;
    return record;
  }

  /**
   * Resume an existing agent session with a new prompt.
   */
  async function resume({ id, prompt, signal }: { id: string; prompt: string; signal?: AbortSignal | undefined }) {
    const record = agents.get(id);
    if (!record?.session) return undefined;

    record.status = "running";
    record.startedAt = Date.now();
    record.completedAt = undefined;
    record.result = undefined;
    record.error = undefined;

    try {
      const responseText = await resumeAgent({
        session: record.session,
        prompt,
        signal,
        callbacks: {
          onToolActivity: (activity: ToolActivity) => {
            if (activity.type === "end") record.toolUses++;
          },
        },
      });
      record.status = "completed";
      record.result = responseText;
      record.completedAt = Date.now();
    } catch (err) {
      record.status = "error";
      record.error = err instanceof Error ? err.message : String(err);
      record.completedAt = Date.now();
    }

    return record;
  }

  function getRecord(id: string) {
    return agents.get(id);
  }

  function listAgents() {
    return [...agents.values()].sort((a, b) => b.startedAt - a.startedAt);
  }

  function abort(id: string) {
    const record = agents.get(id);
    if (!record) return false;

    // Remove from queue if queued
    if (record.status === "queued") {
      queue = queue.filter((q) => q.id !== id);
      record.status = "stopped";
      record.completedAt = Date.now();
      return true;
    }

    if (record.status !== "running") return false;
    record.abortController?.abort();
    record.status = "stopped";
    record.completedAt = Date.now();
    return true;
  }

  function removeRecord(id: string, record: AgentRecord) {
    record.session?.dispose?.();
    record.session = undefined;
    agents.delete(id);
  }

  function cleanup() {
    const cutoff = Date.now() - 10 * 60_000;
    for (const [id, record] of agents) {
      if (record.status === "running" || record.status === "queued") continue;
      if ((record.completedAt ?? 0) >= cutoff) continue;
      removeRecord(id, record);
    }
  }

  /**
   * Remove all completed/stopped/errored records immediately.
   * Called on session start/switch so tasks from a prior session don't persist.
   */
  function clearCompleted() {
    for (const [id, record] of agents) {
      if (record.status === "running" || record.status === "queued") continue;
      removeRecord(id, record);
    }
  }

  function hasRunning() {
    return [...agents.values()].some((r) => r.status === "running" || r.status === "queued");
  }

  function abortAll() {
    let count = 0;
    // Clear queued agents first
    for (const queued of queue) {
      const record = agents.get(queued.id);
      if (record) {
        record.status = "stopped";
        record.completedAt = Date.now();
        count++;
      }
    }
    queue = [];
    // Abort running agents
    for (const record of agents.values()) {
      if (record.status === "running") {
        record.abortController?.abort();
        record.status = "stopped";
        record.completedAt = Date.now();
        count++;
      }
    }
    return count;
  }

  async function waitForAll() {
    // Loop because drainQueue respects the concurrency limit — as running
    // agents finish they start queued ones, which need awaiting too.
    while (true) {
      drainQueue();
      const pending = [...agents.values()]
        .filter((r) => r.status === "running" || r.status === "queued")
        .map((r) => r.promise)
        .filter(Boolean);
      if (pending.length === 0) break;
      await Promise.allSettled(pending);
    }
  }

  function dispose() {
    clearInterval(cleanupInterval);
    // Clear queue
    queue = [];
    for (const record of agents.values()) {
      record.session?.dispose();
    }
    agents.clear();
    // Prune any orphaned git worktrees (crash recovery)
    try {
      pruneWorktrees(process.cwd());
    } catch {
      /* ignore */
    }
  }

  return {
    setRunnerSettings,
    setRegistry,
    setMaxConcurrent,
    getMaxConcurrent,
    spawn,
    spawnAndWait,
    resume,
    getRecord,
    listAgents,
    abort,
    clearCompleted,
    hasRunning,
    abortAll,
    waitForAll,
    dispose,
  };
}

export type AgentManager = ReturnType<typeof createAgentManager>;
