import type { FlowAgentConfig, SingleAgentResult, UsageStats } from './types.js';

// ─── DisplayItem type ─────────────────────────────────────────────────────────

export type DisplayItem =
  | { type: 'text'; text: string }
  | { type: 'toolCall'; name: string; args: Record<string, unknown> };

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
