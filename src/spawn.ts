import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import type { FlowAgentConfig, SingleAgentResult, UsageStats } from './types.js';
import { injectVariables } from './agents.js';

// ─── Constants ────────────────────────────────────────────────────────────────

export const RETRY_DELAYS_MS = [500, 1000, 2000];

// ─── Factory helpers ──────────────────────────────────────────────────────────

export function emptyUsage(): UsageStats {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 };
}

export function emptyResult(agent: FlowAgentConfig, task: string): SingleAgentResult {
  return {
    agent: agent.name,
    agentSource: agent.source,
    task,
    exitCode: -1,
    messages: [],
    stderr: '',
    usage: emptyUsage(),
  };
}

// ─── DisplayItem type ─────────────────────────────────────────────────────────

export type DisplayItem =
  | { type: 'text'; text: string }
  | { type: 'toolCall'; name: string; args: Record<string, unknown> };

// ─── getPiInvocation ─────────────────────────────────────────────────────────

/**
 * Detects the pi binary to use for spawning subagents.
 * Uses process.argv[1] if it exists on disk (running from source/compiled
 * pi binary), otherwise falls back to the "pi" command on PATH.
 *
 * Returns { command, args } ready to pass to child_process.spawn().
 */
export function getPiInvocation(extraArgs: string[]): { command: string; args: string[] } {
  const currentScript = process.argv[1];
  if (currentScript && fs.existsSync(currentScript)) {
    return { command: process.execPath, args: [currentScript, ...extraArgs] };
  }
  return { command: 'pi', args: extraArgs };
}

// ─── buildSpawnArgs ───────────────────────────────────────────────────────────

/**
 * Builds the args array for spawning a pi subprocess in JSON mode.
 *
 * Produces:
 *   ["--mode", "json", "-p", "--no-session", "--no-extensions",
 *    "--model", <model>, "--thinking", <thinking>,
 *    "--tools", <tools csv>,
 *    "--append-system-prompt", <promptPath>,
 *    <task>]
 *
 * --no-extensions is critical: sub-agents cannot spawn sub-agents (§14 S4).
 */
export function buildSpawnArgs(agent: FlowAgentConfig, task: string, promptPath: string): string[] {
  return [
    '--mode',
    'json',
    '-p',
    '--no-session',
    '--no-extensions',
    '--model',
    agent.model,
    '--thinking',
    agent.thinking,
    '--tools',
    agent.tools.join(','),
    '--append-system-prompt',
    promptPath,
    task,
  ];
}

// ─── writeAgentPrompt ─────────────────────────────────────────────────────────

/**
 * Creates a temp directory, injects variables into the agent's system prompt,
 * and writes the result to a temp file (mode 0o600).
 *
 * Returns { dir, filePath } for later cleanup.
 */
export async function writeAgentPrompt(
  agent: FlowAgentConfig,
  variableMap: Record<string, string>,
): Promise<{ dir: string; filePath: string }> {
  const prompt = injectVariables(agent.systemPrompt, variableMap, agent.variables);

  const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), `pi-flow-${agent.name}-`));
  const safeName = agent.name.replace(/[^\w.-]+/g, '_');
  const filePath = path.join(tmpDir, `${safeName}-prompt.md`);

  await fs.promises.writeFile(filePath, prompt, { encoding: 'utf-8', mode: 0o600 });

  return { dir: tmpDir, filePath };
}

// ─── processNdjsonLine ────────────────────────────────────────────────────────

/**
 * Parses a single NDJSON line from the pi subprocess stdout and mutates the
 * result object in place.
 *
 * **Intentional mutation for streaming performance**: updating the result
 * in-place avoids object copies on every NDJSON line, which matters for
 * long-running agents that emit thousands of lines.
 *
 * Handles two event types:
 *   - `message_end`     — push message; if role=assistant, extract usage/model/stopReason
 *   - `tool_result_end` — push message
 *
 * Calls emitUpdate() after processing either event.
 * Silently ignores empty lines, non-JSON, and unknown event types.
 */
export function processNdjsonLine(
  line: string,
  result: SingleAgentResult,
  emitUpdate: () => void,
): void {
  if (!line.trim()) return;

  let event: { type: string; message?: Record<string, unknown> };
  try {
    event = JSON.parse(line);
  } catch {
    // Non-JSON line (e.g. pi startup messages) — ignore
    return;
  }

  if (event.type === 'message_end' && event.message) {
    const msg = event.message;
    result.messages.push(msg);

    if (msg.role === 'assistant') {
      result.usage.turns++;

      const u = msg.usage as Record<string, unknown> | undefined;
      if (u) {
        result.usage.input += (u.input as number) || 0;
        result.usage.output += (u.output as number) || 0;
        result.usage.cacheRead += (u.cacheRead as number) || 0;
        result.usage.cacheWrite += (u.cacheWrite as number) || 0;
        result.usage.cost +=
          ((u.cost as Record<string, unknown> | undefined)?.total as number) || 0;
        result.usage.contextTokens = (u.totalTokens as number) || 0;
      }

      if (!result.model && msg.model) result.model = msg.model as string;
      if (msg.stopReason) result.stopReason = msg.stopReason as string;
      if (msg.errorMessage) result.errorMessage = msg.errorMessage as string;
    }

    emitUpdate();
    return;
  }

  if (event.type === 'tool_result_end' && event.message) {
    result.messages.push(event.message);
    emitUpdate();
  }
}

// ─── aggregateUsage ───────────────────────────────────────────────────────────

/**
 * Sums usage stats across all results.
 * contextTokens is taken from the last result (most recent context window size).
 */
export function aggregateUsage(results: SingleAgentResult[]): UsageStats {
  const zero: UsageStats = {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    cost: 0,
    contextTokens: 0,
    turns: 0,
  };

  if (results.length === 0) return zero;

  return results.reduce(
    (total, r, idx) => ({
      input: total.input + r.usage.input,
      output: total.output + r.usage.output,
      cacheRead: total.cacheRead + r.usage.cacheRead,
      cacheWrite: total.cacheWrite + r.usage.cacheWrite,
      cost: total.cost + r.usage.cost,
      // Last result's contextTokens reflects the most recent context window
      contextTokens: idx === results.length - 1 ? r.usage.contextTokens : total.contextTokens,
      turns: total.turns + r.usage.turns,
    }),
    zero,
  );
}

// ─── getFinalOutput ───────────────────────────────────────────────────────────

/**
 * Walks messages backward to find the last assistant message that contains
 * a text block. Returns the text, or empty string if none found.
 */
export function getFinalOutput(messages: Record<string, unknown>[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.role === 'assistant') {
      for (const part of (msg.content as Record<string, unknown>[] | undefined) ?? []) {
        if (part.type === 'text') return part.text as string;
      }
    }
  }
  return '';
}

// ─── getDisplayItems ──────────────────────────────────────────────────────────

/**
 * Walks all messages and extracts text blocks and tool calls from assistant
 * messages. Returns a flat array in message order for rendering.
 */
export function getDisplayItems(messages: Record<string, unknown>[]): DisplayItem[] {
  const items: DisplayItem[] = [];

  for (const msg of messages) {
    if (msg.role === 'assistant') {
      for (const part of (msg.content as Record<string, unknown>[] | undefined) ?? []) {
        if (part.type === 'text') {
          items.push({ type: 'text', text: part.text as string });
        } else if (part.type === 'toolCall') {
          items.push({
            type: 'toolCall',
            name: part.name as string,
            args: part.arguments as Record<string, unknown>,
          });
        }
      }
    }
  }

  return items;
}

// ─── mapWithConcurrencyLimit ──────────────────────────────────────────────────

/**
 * Processes items with at most `limit` concurrent workers.
 * Results are returned in the same order as the input array.
 *
 * A 150ms stagger (SPAWN_STAGGER_MS) is applied between the first N spawns
 * to reduce simultaneous SQLite lock contention in pi's session files.
 */
export async function mapWithConcurrencyLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  if (items.length === 0) return [];

  const workers = Math.max(1, Math.min(limit, items.length));
  const results: R[] = new Array(items.length);
  let nextIndex = 0;

  const workerFns = Array.from({ length: workers }, async () => {
    while (true) {
      const current = nextIndex++;
      if (current >= items.length) return;
      results[current] = await fn(items[current], current);
    }
  });

  await Promise.all(workerFns);
  return results;
}

// ─── runChildProcess ──────────────────────────────────────────────────────────

/**
 * Spawns the pi child process and streams its stdout/stderr into `currentResult`.
 * Handles AbortSignal: SIGTERM → 5s grace → SIGKILL.
 *
 * Returns the process exit code and whether the run was aborted.
 */
function runChildProcess(
  invocation: { command: string; args: string[] },
  cwd: string,
  currentResult: SingleAgentResult,
  emitUpdate: () => void,
  signal?: AbortSignal,
): Promise<{ exitCode: number; wasAborted: boolean }> {
  return new Promise((resolve) => {
    const proc = spawn(invocation.command, invocation.args, {
      cwd,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let buffer = '';
    let wasAborted = false;

    proc.stdout.on('data', (data: Buffer) => {
      buffer += data.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        processNdjsonLine(line, currentResult, emitUpdate);
      }
    });

    proc.stderr.on('data', (data: Buffer) => {
      currentResult.stderr += data.toString();
    });

    proc.on('close', (code) => {
      // Flush any remaining partial line in the buffer
      if (buffer.trim()) {
        processNdjsonLine(buffer, currentResult, emitUpdate);
      }
      resolve({ exitCode: code ?? 0, wasAborted });
    });

    proc.on('error', () => {
      resolve({ exitCode: 1, wasAborted });
    });

    if (signal) {
      const killProc = () => {
        wasAborted = true;
        proc.kill('SIGTERM');
        const forceKillTimer = setTimeout(() => {
          if (!proc.killed) proc.kill('SIGKILL');
        }, 5000);
        // Prevent the timer from keeping the process alive
        forceKillTimer.unref();
      };

      if (signal.aborted) {
        killProc();
      } else {
        signal.addEventListener('abort', killProc, { once: true });
      }
    }
  });
}

// ─── spawnAgent ───────────────────────────────────────────────────────────────

/**
 * Spawns a pi subprocess for a single agent, streams its NDJSON output,
 * and returns a SingleAgentResult.
 *
 * - Writes the agent's system prompt to a temp file (cleaned up in finally)
 * - Parses stdout line-by-line (buffer-based, handles partial lines)
 * - Accumulates usage stats and messages incrementally
 * - Calls onUpdate after each message_end or tool_result_end event
 * - Handles AbortSignal: SIGTERM → 5s grace → SIGKILL
 */
export async function spawnAgent(
  cwd: string,
  agent: FlowAgentConfig,
  task: string,
  variableMap: Record<string, string>,
  signal?: AbortSignal,
  onUpdate?: (result: SingleAgentResult) => void,
): Promise<SingleAgentResult> {
  const currentResult: SingleAgentResult = {
    agent: agent.name,
    agentSource: agent.source,
    task,
    exitCode: -1, // -1 = running; set to actual exit code when the process closes
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
    model: agent.model || undefined,
  };

  const emitUpdate = () => {
    if (onUpdate) onUpdate({ ...currentResult, messages: [...currentResult.messages] });
  };

  let tmpDir: string | null = null;
  let tmpFilePath: string | null = null;

  try {
    const tmp = await writeAgentPrompt(agent, variableMap);
    tmpDir = tmp.dir;
    tmpFilePath = tmp.filePath;

    const spawnArgs = buildSpawnArgs(agent, task, tmpFilePath);
    const invocation = getPiInvocation(spawnArgs);

    const { exitCode, wasAborted } = await runChildProcess(
      invocation,
      cwd,
      currentResult,
      emitUpdate,
      signal,
    );

    currentResult.exitCode = exitCode;

    if (wasAborted) {
      currentResult.stopReason = 'aborted';
    }

    return currentResult;
  } finally {
    // Clean up temp files regardless of success or failure
    if (tmpFilePath) {
      try {
        fs.unlinkSync(tmpFilePath);
      } catch {
        /* ignore */
      }
    }
    if (tmpDir) {
      try {
        fs.rmdirSync(tmpDir);
      } catch {
        /* ignore */
      }
    }
  }
}

// ─── isTransientError ────────────────────────────────────────────────────────

/**
 * Returns true when the stderr output indicates a transient spawn error
 * that is worth retrying (lock file contention or missing API key on first run).
 */
function isTransientError(result: SingleAgentResult): boolean {
  return result.stderr.includes('Lock file') || result.stderr.includes('No API key found');
}

// ─── spawnAgentWithRetry ──────────────────────────────────────────────────────

/**
 * Wraps spawnAgent with retry logic for transient errors.
 *
 * Retries when:
 *   - The result's stderr contains "Lock file" or "No API key found"
 *
 * Backoff: RETRY_DELAYS_MS = [500, 1000, 2000]
 * Max attempts: 1 (initial) + 3 (retries) = 4 total
 *
 * Returns the result from the first successful (non-transient-error) attempt,
 * or the last failed result if all retries are exhausted.
 */
export async function spawnAgentWithRetry(
  cwd: string,
  agent: FlowAgentConfig,
  task: string,
  variableMap: Record<string, string>,
  signal?: AbortSignal,
  onUpdate?: (result: SingleAgentResult) => void,
  maxRetries = 3,
): Promise<SingleAgentResult> {
  const delays = RETRY_DELAYS_MS.slice(0, maxRetries);
  let lastResult: SingleAgentResult | undefined;

  for (let attempt = 0; attempt <= delays.length; attempt++) {
    try {
      const result = await spawnAgent(cwd, agent, task, variableMap, signal, onUpdate);

      if (isTransientError(result) && attempt < delays.length) {
        lastResult = result;
        await new Promise<void>((r) => setTimeout(r, delays[attempt]));
        continue;
      }

      return result;
    } catch (err) {
      lastResult = {
        agent: agent.name,
        agentSource: agent.source,
        task,
        exitCode: 1,
        messages: [],
        stderr: err instanceof Error ? err.message : String(err),
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          cost: 0,
          contextTokens: 0,
          turns: 0,
        },
      };

      if (attempt < delays.length) {
        await new Promise<void>((r) => setTimeout(r, delays[attempt]));
      }
    }
  }

  // All retries exhausted — return the last known result
  return (
    lastResult ?? {
      agent: agent.name,
      agentSource: agent.source,
      task,
      exitCode: 1,
      messages: [],
      stderr: 'Spawn failed after retries',
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        cost: 0,
        contextTokens: 0,
        turns: 0,
      },
    }
  );
}
