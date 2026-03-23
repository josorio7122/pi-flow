import { execSync } from 'node:child_process';

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
      message:
        `HALT: Cost cap exceeded. $${total.toFixed(2)} spent of $${capUsd.toFixed(2)} cap.`,
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
      message:
        `HALT: Token cap exceeded. ${total.toLocaleString()} tokens used of ${capTokens.toLocaleString()} cap.`,
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
 * args object's keys before stringifying. Returns a compact numeric string.
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

  // Count occurrences of each composite key in the window
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

  // Find the maximum-count pair
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

// ── Scope creep ───────────────────────────────────────────────────────────────

export interface ScopeCreepResult {
  warn: boolean;
  halt: boolean;
  ratio: number;
  message: string;
}

/**
 * Checks whether the number of actually-changed files has grown beyond the
 * planned count by more than the warning or halt thresholds.
 *
 * Per §13 C7: thresholds are strictly greater-than (ratio > 1 + threshold),
 * so a ratio of exactly 1.30 with haltThreshold=0.30 does NOT halt.
 *
 * @param plannedFiles     - files declared in this wave's scope
 * @param actualFiles      - files actually changed
 * @param warningThreshold - default 0.20 (warn when ratio > 1.20)
 * @param haltThreshold    - default 0.30 (halt when ratio > 1.30)
 */
export function checkScopeCreep(
  plannedFiles: number,
  actualFiles: number,
  warningThreshold: number,
  haltThreshold: number,
): ScopeCreepResult {
  // Treat 0 planned files as no-op (ratio 1) to avoid division by zero
  const ratio = plannedFiles > 0 ? actualFiles / plannedFiles : 1;

  if (ratio > 1 + haltThreshold) {
    return {
      warn: true,
      halt: true,
      ratio,
      message:
        `HALT: Scope creep detected. ${actualFiles} files changed, ${plannedFiles} planned ` +
        `(ratio ${ratio.toFixed(2)} > ${(1 + haltThreshold).toFixed(2)}).`,
    };
  }

  if (ratio > 1 + warningThreshold) {
    return {
      warn: true,
      halt: false,
      ratio,
      message:
        `WARN: Scope expanding. ${actualFiles} files changed, ${plannedFiles} planned ` +
        `(ratio ${ratio.toFixed(2)}).`,
    };
  }

  return {
    warn: false,
    halt: false,
    ratio,
    message: `OK: ${actualFiles}/${plannedFiles} files changed.`,
  };
}

// ── Analysis paralysis ────────────────────────────────────────────────────────

export interface AnalysisParalysisResult {
  tripped: boolean;
  count: number;
}

const READ_ONLY_TOOLS = new Set(['read', 'grep', 'find', 'ls']);

/**
 * Counts consecutive read-only tool calls from the end of the array.
 * bash, write, and edit reset the streak to zero.
 * Trips when the streak reaches `threshold`.
 */
export function checkAnalysisParalysis(
  recentCalls: Array<{ tool: string }>,
  threshold: number,
): AnalysisParalysisResult {
  let count = 0;

  // Walk backwards from the end to find the streak length
  for (let i = recentCalls.length - 1; i >= 0; i--) {
    if (READ_ONLY_TOOLS.has(recentCalls[i].tool)) {
      count += 1;
    } else {
      // Action tool encountered — streak ends here
      break;
    }
  }

  return { tripped: count >= threshold, count };
}

// ── Git activity watchdog ─────────────────────────────────────────────────────

export interface GitActivityResult {
  hasCommits: boolean;
  commitCount: number;
}

/**
 * Runs `git log --oneline --since="N minutes ago"` in `cwd` and returns the
 * count of commits. Handles errors gracefully (not a git repo, etc.).
 */
export async function checkGitActivity(
  cwd: string,
  sinceMinutes: number,
): Promise<GitActivityResult> {
  try {
    const output = execSync(
      `git log --oneline --since="${sinceMinutes} minutes ago"`,
      { cwd, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] },
    );

    const lines = output.split('\n').filter((l) => l.trim().length > 0);
    return { hasCommits: lines.length > 0, commitCount: lines.length };
  } catch {
    return { hasCommits: false, commitCount: 0 };
  }
}

// ── Cost estimation ───────────────────────────────────────────────────────────

interface ModelPricing {
  inputPerMillion: number;
  outputPerMillion: number;
}

const PRICING: Record<string, ModelPricing> = {
  sonnet: { inputPerMillion: 3.0, outputPerMillion: 15.0 },
  opus: { inputPerMillion: 15.0, outputPerMillion: 75.0 },
  haiku: { inputPerMillion: 0.25, outputPerMillion: 1.25 },
};

/**
 * Estimates USD cost for a model + usage combination.
 * Matches model tier by substring: "sonnet", "opus", "haiku".
 * Falls back to sonnet pricing for unknown models.
 */
export function estimateCost(
  model: string,
  usage: { input: number; output: number; cacheRead: number; cacheWrite: number },
): number {
  const modelLower = model.toLowerCase();

  let pricing: ModelPricing;
  if (modelLower.includes('opus')) {
    pricing = PRICING.opus;
  } else if (modelLower.includes('haiku')) {
    pricing = PRICING.haiku;
  } else {
    // sonnet or unknown — fall back to sonnet
    pricing = PRICING.sonnet;
  }

  const inputCost = (usage.input / 1_000_000) * pricing.inputPerMillion;
  const outputCost = (usage.output / 1_000_000) * pricing.outputPerMillion;

  return inputCost + outputCost;
}

// ── Internal helpers ──────────────────────────────────────────────────────────

/** JSON.stringify with sorted keys for deterministic output. */
function sortedStringify(obj: unknown): string {
  if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) {
    return JSON.stringify(obj);
  }
  const sorted = Object.fromEntries(
    Object.entries(obj as Record<string, unknown>).sort(([a], [b]) =>
      a < b ? -1 : a > b ? 1 : 0,
    ),
  );
  return JSON.stringify(sorted);
}

/** Simple djb2-style string hash returning an unsigned 32-bit integer. */
function simpleHash(str: string): number {
  let hash = 5381;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) + hash) ^ str.charCodeAt(i);
    hash = hash >>> 0; // keep unsigned 32-bit
  }
  return hash;
}
