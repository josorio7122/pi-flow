import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

import {
  checkBudget,
  checkTokenBudget,
  detectLoop,
  hashToolCall,
  checkScopeCreep,
  checkAnalysisParalysis,
  checkGitActivity,
  estimateCost,
} from './guardrails.js';

// ── checkBudget ───────────────────────────────────────────────────────────────

describe('checkBudget', () => {
  it('returns no warn/halt when well under cap', () => {
    const result = checkBudget(0, 1.00, 10.00);
    expect(result.warn).toBe(false);
    expect(result.halt).toBe(false);
  });

  it('warns at exactly 80% of cap', () => {
    // total = 8.00 (80% of 10.00)
    const result = checkBudget(7.00, 1.00, 10.00);
    expect(result.warn).toBe(true);
    expect(result.halt).toBe(false);
    expect(result.message).toMatch(/warn/i);
  });

  it('warns above 80% but below 100%', () => {
    const result = checkBudget(8.50, 0.50, 10.00);
    expect(result.warn).toBe(true);
    expect(result.halt).toBe(false);
  });

  it('halts at exactly 100% of cap', () => {
    const result = checkBudget(9.00, 1.00, 10.00);
    expect(result.halt).toBe(true);
    expect(result.message).toMatch(/halt/i);
  });

  it('halts above 100% of cap', () => {
    const result = checkBudget(10.00, 1.00, 10.00);
    expect(result.halt).toBe(true);
  });

  it('does not warn at just under 80%', () => {
    // total = 7.99 — not yet at 80%
    const result = checkBudget(7.00, 0.99, 10.00);
    expect(result.warn).toBe(false);
    expect(result.halt).toBe(false);
  });

  it('message includes current and cap amounts', () => {
    const result = checkBudget(0, 8.50, 10.00);
    expect(result.message).toMatch(/8\.50|8.5/);
    expect(result.message).toMatch(/10\.00|10/);
  });
});

// ── checkTokenBudget ──────────────────────────────────────────────────────────

describe('checkTokenBudget', () => {
  it('returns no warn/halt when well under cap', () => {
    const result = checkTokenBudget(0, 10000, 100000);
    expect(result.warn).toBe(false);
    expect(result.halt).toBe(false);
  });

  it('warns at exactly 80% of token cap', () => {
    // total = 80000 (80% of 100000)
    const result = checkTokenBudget(70000, 10000, 100000);
    expect(result.warn).toBe(true);
    expect(result.halt).toBe(false);
    expect(result.message).toMatch(/warn/i);
  });

  it('halts at exactly 100% of token cap', () => {
    const result = checkTokenBudget(90000, 10000, 100000);
    expect(result.halt).toBe(true);
    expect(result.message).toMatch(/halt/i);
  });

  it('does not warn at just under 80%', () => {
    const result = checkTokenBudget(70000, 9999, 100000);
    expect(result.warn).toBe(false);
    expect(result.halt).toBe(false);
  });

  it('message includes token counts', () => {
    const result = checkTokenBudget(0, 80000, 100000);
    expect(result.message).toMatch(/80[,.]?000|80000/);
  });
});

// ── hashToolCall ──────────────────────────────────────────────────────────────

describe('hashToolCall', () => {
  it('returns a non-empty string', () => {
    const h = hashToolCall('read', { path: '/foo/bar' });
    expect(typeof h).toBe('string');
    expect(h.length).toBeGreaterThan(0);
  });

  it('same tool + same args produce the same hash', () => {
    const h1 = hashToolCall('read', { path: '/foo/bar' });
    const h2 = hashToolCall('read', { path: '/foo/bar' });
    expect(h1).toBe(h2);
  });

  it('different tool name produces different hash', () => {
    const h1 = hashToolCall('read', { path: '/foo/bar' });
    const h2 = hashToolCall('grep', { path: '/foo/bar' });
    expect(h1).not.toBe(h2);
  });

  it('different args produce different hash', () => {
    const h1 = hashToolCall('read', { path: '/foo/bar' });
    const h2 = hashToolCall('read', { path: '/foo/baz' });
    expect(h1).not.toBe(h2);
  });

  it('arg key order does not affect hash (sorted keys)', () => {
    const h1 = hashToolCall('tool', { b: 2, a: 1 });
    const h2 = hashToolCall('tool', { a: 1, b: 2 });
    expect(h1).toBe(h2);
  });
});

// ── detectLoop ────────────────────────────────────────────────────────────────

describe('detectLoop', () => {
  it('returns not tripped when history is empty', () => {
    const result = detectLoop([], 10, 3);
    expect(result.tripped).toBe(false);
    expect(result.tool).toBeNull();
    expect(result.count).toBe(0);
  });

  it('returns not tripped when repetitions are below threshold', () => {
    const history = [
      { tool: 'read', argsHash: 'abc' },
      { tool: 'read', argsHash: 'abc' },
    ];
    const result = detectLoop(history, 10, 3);
    expect(result.tripped).toBe(false);
  });

  it('trips when same tool+hash appears threshold times', () => {
    const history = [
      { tool: 'read', argsHash: 'abc' },
      { tool: 'read', argsHash: 'abc' },
      { tool: 'read', argsHash: 'abc' },
    ];
    const result = detectLoop(history, 10, 3);
    expect(result.tripped).toBe(true);
    expect(result.tool).toBe('read');
    expect(result.count).toBe(3);
  });

  it('respects the sliding window — only last N calls counted', () => {
    // 5 old calls of 'read abc', then window=3 with only 2 within window
    const history = [
      { tool: 'read', argsHash: 'abc' },
      { tool: 'read', argsHash: 'abc' },
      { tool: 'read', argsHash: 'abc' },
      { tool: 'grep', argsHash: 'xyz' }, // interrupts within window
      { tool: 'read', argsHash: 'abc' },
      { tool: 'read', argsHash: 'abc' },
    ];
    // window=3 → last 3 entries: grep:xyz, read:abc, read:abc → max count = 2 < 3
    const result = detectLoop(history, 3, 3);
    expect(result.tripped).toBe(false);
  });

  it('different argsHash for same tool does not trip', () => {
    const history = [
      { tool: 'read', argsHash: 'abc' },
      { tool: 'read', argsHash: 'def' },
      { tool: 'read', argsHash: 'ghi' },
    ];
    const result = detectLoop(history, 10, 3);
    expect(result.tripped).toBe(false);
  });

  it('returns the tool name and count when tripped', () => {
    const history = [
      { tool: 'grep', argsHash: 'h1' },
      { tool: 'grep', argsHash: 'h1' },
      { tool: 'grep', argsHash: 'h1' },
      { tool: 'grep', argsHash: 'h1' },
    ];
    const result = detectLoop(history, 10, 3);
    expect(result.tripped).toBe(true);
    expect(result.tool).toBe('grep');
    expect(result.count).toBe(4);
  });

  it('trips on the most-repeated pair when multiple pairs exist', () => {
    const history = [
      { tool: 'read', argsHash: 'a' },
      { tool: 'grep', argsHash: 'b' },
      { tool: 'read', argsHash: 'a' },
      { tool: 'grep', argsHash: 'b' },
      { tool: 'read', argsHash: 'a' },
    ];
    const result = detectLoop(history, 10, 3);
    expect(result.tripped).toBe(true);
    expect(result.tool).toBe('read');
    expect(result.count).toBe(3);
  });
});

// ── checkScopeCreep ───────────────────────────────────────────────────────────

describe('checkScopeCreep', () => {
  it('returns ok when actual equals planned', () => {
    const result = checkScopeCreep(10, 10, 0.20, 0.30);
    expect(result.warn).toBe(false);
    expect(result.halt).toBe(false);
    expect(result.ratio).toBeCloseTo(1.0);
  });

  it('returns ok when actual is less than planned', () => {
    const result = checkScopeCreep(10, 8, 0.20, 0.30);
    expect(result.warn).toBe(false);
    expect(result.halt).toBe(false);
  });

  it('returns ok at exactly 20% over (boundary — not strictly over)', () => {
    // ratio = 12/10 = 1.20 — not > 1.20
    const result = checkScopeCreep(10, 12, 0.20, 0.30);
    expect(result.warn).toBe(false);
    expect(result.halt).toBe(false);
  });

  it('warns when ratio is strictly over 20%', () => {
    // ratio = 13/10 = 1.30 — > 1.20 but not > 1.30
    const result = checkScopeCreep(10, 13, 0.20, 0.30);
    expect(result.warn).toBe(true);
    expect(result.halt).toBe(false);
    expect(result.message).toMatch(/warn/i);
  });

  it('returns ok at exactly 30% over (boundary — not strictly > 30%)', () => {
    // ratio = 13/10 = 1.30 — §13 C7: strictly > 1.30 required for halt
    const result = checkScopeCreep(10, 13, 0.20, 0.30);
    expect(result.halt).toBe(false);
  });

  it('halts when ratio is strictly over 30% (14/10 = 1.40)', () => {
    const result = checkScopeCreep(10, 14, 0.20, 0.30);
    expect(result.halt).toBe(true);
    expect(result.message).toMatch(/halt/i);
  });

  it('ratio is included in the result', () => {
    const result = checkScopeCreep(10, 15, 0.20, 0.30);
    expect(result.ratio).toBeCloseTo(1.5);
  });

  it('handles plannedFiles = 0 without crashing', () => {
    // ratio should be 1 (no plan = treat as exactly on target)
    const result = checkScopeCreep(0, 5, 0.20, 0.30);
    expect(result).toBeDefined();
  });
});

// ── checkAnalysisParalysis ────────────────────────────────────────────────────

describe('checkAnalysisParalysis', () => {
  const readOnly = ['read', 'grep', 'find', 'ls'];
  const action = ['bash', 'write', 'edit'];

  it('returns not tripped when array is empty', () => {
    const result = checkAnalysisParalysis([], 8);
    expect(result.tripped).toBe(false);
    expect(result.count).toBe(0);
  });

  it('counts consecutive read-only calls from the end', () => {
    const calls = [
      { tool: 'read' },
      { tool: 'read' },
      { tool: 'read' },
    ];
    const result = checkAnalysisParalysis(calls, 8);
    expect(result.count).toBe(3);
    expect(result.tripped).toBe(false);
  });

  it('trips when consecutive read-only count reaches threshold', () => {
    const calls = Array.from({ length: 8 }, () => ({ tool: 'read' }));
    const result = checkAnalysisParalysis(calls, 8);
    expect(result.tripped).toBe(true);
    expect(result.count).toBe(8);
  });

  it('resets counter when bash appears before the tail', () => {
    const calls = [
      { tool: 'read' },
      { tool: 'read' },
      { tool: 'read' },
      { tool: 'bash' }, // resets counter
      { tool: 'read' },
      { tool: 'read' },
    ];
    const result = checkAnalysisParalysis(calls, 8);
    expect(result.count).toBe(2);
    expect(result.tripped).toBe(false);
  });

  it('resets counter when write appears', () => {
    const calls = [
      ...Array.from({ length: 5 }, () => ({ tool: 'grep' })),
      { tool: 'write' },
      { tool: 'grep' },
      { tool: 'grep' },
      { tool: 'grep' },
    ];
    const result = checkAnalysisParalysis(calls, 8);
    expect(result.count).toBe(3);
    expect(result.tripped).toBe(false);
  });

  it('resets counter when edit appears', () => {
    const calls = [
      ...Array.from({ length: 5 }, () => ({ tool: 'ls' })),
      { tool: 'edit' },
      { tool: 'find' },
    ];
    const result = checkAnalysisParalysis(calls, 8);
    expect(result.count).toBe(1);
    expect(result.tripped).toBe(false);
  });

  it('counts all four read-only tool types', () => {
    const calls = [
      { tool: 'read' },
      { tool: 'grep' },
      { tool: 'find' },
      { tool: 'ls' },
      { tool: 'read' },
      { tool: 'grep' },
      { tool: 'find' },
      { tool: 'ls' },
    ];
    const result = checkAnalysisParalysis(calls, 8);
    expect(result.tripped).toBe(true);
    expect(result.count).toBe(8);
  });

  it('does not trip at threshold - 1', () => {
    const calls = Array.from({ length: 7 }, () => ({ tool: 'grep' }));
    const result = checkAnalysisParalysis(calls, 8);
    expect(result.tripped).toBe(false);
    expect(result.count).toBe(7);
  });
});

// ── estimateCost ──────────────────────────────────────────────────────────────

describe('estimateCost', () => {
  const usage = { input: 1_000_000, output: 1_000_000, cacheRead: 0, cacheWrite: 0 };

  it('estimates sonnet cost correctly ($3/1M input + $15/1M output)', () => {
    const cost = estimateCost('claude-sonnet-4-5', usage);
    expect(cost).toBeCloseTo(18.0, 2); // 3 + 15
  });

  it('estimates opus cost correctly ($15/1M input + $75/1M output)', () => {
    const cost = estimateCost('claude-opus-4-5', usage);
    expect(cost).toBeCloseTo(90.0, 2); // 15 + 75
  });

  it('estimates haiku cost correctly ($0.25/1M input + $1.25/1M output)', () => {
    const cost = estimateCost('claude-haiku-3-5', usage);
    expect(cost).toBeCloseTo(1.5, 2); // 0.25 + 1.25
  });

  it('returns 0 for zero usage', () => {
    const cost = estimateCost('claude-sonnet-4-5', {
      input: 0, output: 0, cacheRead: 0, cacheWrite: 0,
    });
    expect(cost).toBe(0);
  });

  it('falls back to sonnet pricing for unknown models', () => {
    const cost = estimateCost('unknown-model-xyz', usage);
    expect(cost).toBeCloseTo(18.0, 2);
  });

  it('handles partial usage (only output tokens)', () => {
    const cost = estimateCost('claude-sonnet-4-5', {
      input: 0, output: 1_000_000, cacheRead: 0, cacheWrite: 0,
    });
    expect(cost).toBeCloseTo(15.0, 2);
  });

  it('handles partial usage (only input tokens)', () => {
    const cost = estimateCost('claude-sonnet-4-5', {
      input: 1_000_000, output: 0, cacheRead: 0, cacheWrite: 0,
    });
    expect(cost).toBeCloseTo(3.0, 2);
  });
});

// ── checkGitActivity ─────────────────────────────────────────────────────────

describe('checkGitActivity', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-flow-git-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns hasCommits=false for a fresh repo with no commits', async () => {
    // init repo but make no commits
    const { execSync } = await import('node:child_process');
    execSync('git init', { cwd: tmpDir });
    execSync('git config user.email "test@test.com"', { cwd: tmpDir });
    execSync('git config user.name "Test"', { cwd: tmpDir });

    const result = await checkGitActivity(tmpDir, 5);
    expect(result.hasCommits).toBe(false);
    expect(result.commitCount).toBe(0);
  });

  it('returns hasCommits=true when a recent commit exists', async () => {
    const { execSync } = await import('node:child_process');
    execSync('git init', { cwd: tmpDir });
    execSync('git config user.email "test@test.com"', { cwd: tmpDir });
    execSync('git config user.name "Test"', { cwd: tmpDir });

    // create a commit
    fs.writeFileSync(path.join(tmpDir, 'file.txt'), 'hello');
    execSync('git add file.txt', { cwd: tmpDir });
    execSync('git commit -m "initial"', { cwd: tmpDir });

    const result = await checkGitActivity(tmpDir, 5);
    expect(result.hasCommits).toBe(true);
    expect(result.commitCount).toBe(1);
  });

  it('handles non-git directories gracefully (no throw)', async () => {
    const result = await checkGitActivity(tmpDir, 5);
    expect(result.hasCommits).toBe(false);
    expect(result.commitCount).toBe(0);
  });
});
