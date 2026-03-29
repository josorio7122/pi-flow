import { describe, it, expect } from 'vitest';
import {
  formatTokens,
  formatTurns,
  formatMs,
  formatDuration,
  describeActivity,
  SPINNER,
} from './agent-widget.js';

describe('formatTokens', () => {
  it('formats small counts as-is', () => {
    expect(formatTokens(500)).toBe('500');
  });
  it('formats thousands as k', () => {
    expect(formatTokens(33800)).toBe('33.8k');
  });
  it('formats millions as M', () => {
    expect(formatTokens(1_500_000)).toBe('1.5M');
  });
});

describe('formatTurns', () => {
  it('formats without max', () => {
    expect(formatTurns(5)).toBe('⟳5');
  });
  it('formats with max', () => {
    expect(formatTurns(5, 30)).toBe('⟳5≤30');
  });
});

describe('formatMs', () => {
  it('formats as seconds', () => {
    expect(formatMs(1500)).toBe('1.5s');
  });
});

describe('formatDuration', () => {
  it('shows completed duration', () => {
    expect(formatDuration(1000, 2500)).toBe('1.5s');
  });
  it('shows running duration', () => {
    const result = formatDuration(Date.now() - 1000);
    expect(result).toContain('(running)');
  });
});

describe('describeActivity', () => {
  it('describes active tools', () => {
    const tools = new Map([
      ['1', 'read'],
      ['2', 'grep'],
    ]);
    expect(describeActivity(tools)).toContain('reading');
    expect(describeActivity(tools)).toContain('searching');
  });

  it('shows response text when no tools active', () => {
    const result = describeActivity(new Map(), 'I found 3 files.');
    expect(result).toBe('I found 3 files.');
  });

  it('shows thinking when nothing available', () => {
    expect(describeActivity(new Map())).toBe('thinking…');
  });

  it('truncates long response text', () => {
    const long = 'x'.repeat(100);
    const result = describeActivity(new Map(), long);
    expect(result.length).toBeLessThanOrEqual(62); // 60 + "…"
  });
});

describe('SPINNER', () => {
  it('has 10 frames', () => {
    expect(SPINNER).toHaveLength(10);
  });
});
