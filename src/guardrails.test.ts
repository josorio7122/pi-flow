import { describe, it, expect } from 'vitest';

import { detectLoop, hashToolCall } from './guardrails.js';

// ── hashToolCall ──────────────────────────────────────────────────────────────

describe('hashToolCall', () => {
  it('returns a string hash', () => {
    const hash = hashToolCall('read', { path: '/src/file.ts' });
    expect(typeof hash).toBe('string');
    expect(hash.length).toBeGreaterThan(0);
  });

  it('returns the same hash for identical calls', () => {
    const hash1 = hashToolCall('read', { path: '/src/file.ts' });
    const hash2 = hashToolCall('read', { path: '/src/file.ts' });
    expect(hash1).toBe(hash2);
  });

  it('returns different hashes for different tools', () => {
    const hash1 = hashToolCall('read', { path: '/src/file.ts' });
    const hash2 = hashToolCall('write', { path: '/src/file.ts' });
    expect(hash1).not.toBe(hash2);
  });

  it('returns different hashes for different args', () => {
    const hash1 = hashToolCall('read', { path: '/src/a.ts' });
    const hash2 = hashToolCall('read', { path: '/src/b.ts' });
    expect(hash1).not.toBe(hash2);
  });

  it('produces the same hash regardless of key order', () => {
    const hash1 = hashToolCall('bash', { command: 'ls', timeout: 30 });
    const hash2 = hashToolCall('bash', { timeout: 30, command: 'ls' });
    expect(hash1).toBe(hash2);
  });

  it('handles empty args', () => {
    const hash = hashToolCall('read', {});
    expect(typeof hash).toBe('string');
  });
});

// ── detectLoop ────────────────────────────────────────────────────────────────

describe('detectLoop', () => {
  it('does not trip with no history', () => {
    const result = detectLoop([], 10, 3);
    expect(result.tripped).toBe(false);
  });

  it('does not trip when count is below threshold', () => {
    const history = [
      { tool: 'read', argsHash: 'abc' },
      { tool: 'read', argsHash: 'abc' },
    ];
    const result = detectLoop(history, 10, 3);
    expect(result.tripped).toBe(false);
  });

  it('trips when count reaches threshold', () => {
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

  it('only considers the last window entries', () => {
    const history = [
      { tool: 'read', argsHash: 'abc' },
      { tool: 'read', argsHash: 'abc' },
      { tool: 'read', argsHash: 'abc' },
      { tool: 'write', argsHash: 'def' },
      { tool: 'bash', argsHash: 'ghi' },
    ];
    const result = detectLoop(history, 3, 3);
    expect(result.tripped).toBe(false);
  });

  it('detects loop for any tool, not just read', () => {
    const history = [
      { tool: 'bash', argsHash: 'same' },
      { tool: 'bash', argsHash: 'same' },
      { tool: 'bash', argsHash: 'same' },
    ];
    const result = detectLoop(history, 10, 3);
    expect(result.tripped).toBe(true);
    expect(result.tool).toBe('bash');
  });

  it('does not trip for different argsHash', () => {
    const history = [
      { tool: 'read', argsHash: 'a' },
      { tool: 'read', argsHash: 'b' },
      { tool: 'read', argsHash: 'c' },
    ];
    const result = detectLoop(history, 10, 3);
    expect(result.tripped).toBe(false);
  });

  it('handles mixed tools', () => {
    const history = [
      { tool: 'read', argsHash: 'x' },
      { tool: 'write', argsHash: 'x' },
      { tool: 'read', argsHash: 'x' },
    ];
    const result = detectLoop(history, 10, 3);
    expect(result.tripped).toBe(false);
  });
});
