import { describe, it, expect } from 'vitest';

import {
  checkBudget,
  checkTokenBudget,
  detectLoop,
  hashToolCall,
} from './guardrails.js';

// ── checkBudget ───────────────────────────────────────────────────────────────

describe('checkBudget', () => {
  it('returns no warn/halt when well under cap', () => {
    const result = checkBudget(0, 1.0, 10.0);
    expect(result.warn).toBe(false);
    expect(result.halt).toBe(false);
  });

  it('warns at exactly 80% of cap', () => {
    // total = 8.00 (80% of 10.00)
    const result = checkBudget(7.0, 1.0, 10.0);
    expect(result.warn).toBe(true);
    expect(result.halt).toBe(false);
    expect(result.message).toMatch(/warn/i);
  });

  it('warns above 80% but below 100%', () => {
    const result = checkBudget(8.5, 0.5, 10.0);
    expect(result.warn).toBe(true);
    expect(result.halt).toBe(false);
  });

  it('halts at exactly 100% of cap', () => {
    const result = checkBudget(9.0, 1.0, 10.0);
    expect(result.halt).toBe(true);
    expect(result.message).toMatch(/halt/i);
  });

  it('halts above 100% of cap', () => {
    const result = checkBudget(10.0, 1.0, 10.0);
    expect(result.halt).toBe(true);
  });

  it('does not warn at just under 80%', () => {
    // total = 7.99 — not yet at 80%
    const result = checkBudget(7.0, 0.99, 10.0);
    expect(result.warn).toBe(false);
    expect(result.halt).toBe(false);
  });

  it('message includes current and cap amounts', () => {
    const result = checkBudget(0, 8.5, 10.0);
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

