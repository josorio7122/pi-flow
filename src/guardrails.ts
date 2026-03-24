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
  return String(simpleHash(`${tool}|${sortedArgs}`));
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

function sortedStringify(obj: unknown): string {
  if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) {
    return JSON.stringify(obj);
  }
  const sorted = Object.fromEntries(
    Object.entries(obj as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
  );
  return JSON.stringify(sorted);
}

function simpleHash(str: string): number {
  let hash = 5381;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) + hash) ^ str.charCodeAt(i);
    hash = hash >>> 0;
  }
  return hash;
}
