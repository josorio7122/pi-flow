// ── Budget guards ─────────────────────────────────────────────────────────────

export interface BudgetCheckResult {
  warn: boolean;
  halt: boolean;
  message: string;
}

/**
 * Checks whether accumulated USD cost has crossed the 80% warning or 100% halt
 * thresholds for a per-agent cost cap.
 */
export function checkBudget(
  totalCostUsd: number,
  newCostUsd: number,
  capUsd: number,
): BudgetCheckResult {
  const total = totalCostUsd + newCostUsd;

  if (total >= capUsd) {
    return {
      warn: true,
      halt: true,
      message: `HALT: Cost cap exceeded. $${total.toFixed(2)} spent of $${capUsd.toFixed(2)} cap.`,
    };
  }

  if (total >= capUsd * 0.8) {
    return {
      warn: true,
      halt: false,
      message:
        `WARN: Approaching cost cap. $${total.toFixed(2)} spent of $${capUsd.toFixed(2)} cap ` +
        `(${((total / capUsd) * 100).toFixed(0)}%). Complete your current task.`,
    };
  }

  return { warn: false, halt: false, message: '' };
}

/**
 * Checks whether accumulated token usage has crossed the 80% warning or 100%
 * halt thresholds for a per-agent token cap.
 */
export function checkTokenBudget(
  totalTokens: number,
  newTokens: number,
  capTokens: number,
): BudgetCheckResult {
  const total = totalTokens + newTokens;

  if (total >= capTokens) {
    return {
      warn: true,
      halt: true,
      message: `HALT: Token cap exceeded. ${total.toLocaleString()} tokens used of ${capTokens.toLocaleString()} cap.`,
    };
  }

  if (total >= capTokens * 0.8) {
    return {
      warn: true,
      halt: false,
      message:
        `WARN: Approaching token cap. ${total.toLocaleString()} tokens used of ${capTokens.toLocaleString()} cap ` +
        `(${((total / capTokens) * 100).toFixed(0)}%). Complete your current task.`,
    };
  }

  return { warn: false, halt: false, message: '' };
}

// ── Loop detection ────────────────────────────────────────────────────────────

export interface LoopDetectionResult {
  tripped: boolean;
  tool: string | null;
  count: number;
}

/**
 * Creates a deterministic hash key for a (tool, args) pair by sorting the
 * args object's keys before stringifying.
 */
export function hashToolCall(tool: string, args: Record<string, unknown>): string {
  const sortedArgs = sortedStringify(args);
  const raw = `${tool}|${sortedArgs}`;
  return String(simpleHash(raw));
}

/**
 * Detects whether the same (tool, argsHash) pair has appeared >= threshold
 * times within the last `window` entries of the history array.
 */
export function detectLoop(
  history: Array<{ tool: string; argsHash: string }>,
  window: number,
  threshold: number,
): LoopDetectionResult {
  const slice = history.slice(-window);

  const counts = new Map<string, { tool: string; count: number }>();

  for (const entry of slice) {
    const key = `${entry.tool}|${entry.argsHash}`;
    const existing = counts.get(key);
    if (existing) {
      existing.count += 1;
    } else {
      counts.set(key, { tool: entry.tool, count: 1 });
    }
  }

  let maxCount = 0;
  let maxTool: string | null = null;

  for (const { tool, count } of counts.values()) {
    if (count > maxCount) {
      maxCount = count;
      maxTool = tool;
    }
  }

  if (maxCount >= threshold) {
    return { tripped: true, tool: maxTool, count: maxCount };
  }

  return { tripped: false, tool: null, count: maxCount };
}

// ── Internal helpers ──────────────────────────────────────────────────────────

/** JSON.stringify with sorted keys for deterministic output. */
function sortedStringify(obj: unknown): string {
  if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) {
    return JSON.stringify(obj);
  }
  const sorted = Object.fromEntries(
    Object.entries(obj as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
  );
  return JSON.stringify(sorted);
}

/** Simple djb2-style string hash returning an unsigned 32-bit integer. */
function simpleHash(str: string): number {
  let hash = 5381;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) + hash) ^ str.charCodeAt(i);
    hash = hash >>> 0;
  }
  return hash;
}
