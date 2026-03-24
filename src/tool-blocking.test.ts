import { describe, it, expect } from 'vitest';

import { isFlowPath, shouldBlockToolCall } from './tool-blocking.js';

describe('isFlowPath', () => {
  it('allows .flow/state.md', () => {
    expect(isFlowPath('.flow/state.md')).toBe(true);
  });

  it('allows .flow/features/auth/spec.md', () => {
    expect(isFlowPath('.flow/features/auth/spec.md')).toBe(true);
  });

  it('allows bare .flow', () => {
    expect(isFlowPath('.flow')).toBe(true);
  });

  it('rejects src/main.ts', () => {
    expect(isFlowPath('src/main.ts')).toBe(false);
  });

  it('rejects traversal ../.flow/exploit.md', () => {
    expect(isFlowPath('../.flow/exploit.md')).toBe(false);
  });

  it('rejects .flow-utils/file.ts (prefix match without separator)', () => {
    expect(isFlowPath('.flow-utils/file.ts')).toBe(false);
  });

  it('allows absolute path with .flow segment', () => {
    expect(isFlowPath('/Users/dev/project/.flow/state.md')).toBe(true);
  });

  it('rejects absolute path without .flow', () => {
    expect(isFlowPath('/Users/dev/project/src/main.ts')).toBe(false);
  });
});

describe('shouldBlockToolCall', () => {
  it('allows read tool', () => {
    expect(shouldBlockToolCall('read', { path: 'src/main.ts' })).toEqual({});
  });

  it('allows bash tool', () => {
    expect(shouldBlockToolCall('bash', { command: 'ls' })).toEqual({});
  });

  it('allows dispatch_flow tool', () => {
    expect(shouldBlockToolCall('dispatch_flow', {})).toEqual({});
  });

  it('allows Write to .flow/', () => {
    expect(shouldBlockToolCall('Write', { path: '.flow/notes.md' })).toEqual({});
  });

  it('allows Edit to .flow/', () => {
    expect(shouldBlockToolCall('Edit', { path: '.flow/features/auth/spec.md' })).toEqual({});
  });

  it('blocks Write to src/', () => {
    const result = shouldBlockToolCall('Write', { path: 'src/main.ts' });
    expect(result.block).toBe(true);
    expect(result.reason).toBeDefined();
  });

  it('blocks Edit to src/', () => {
    const result = shouldBlockToolCall('Edit', { path: 'src/auth.ts' });
    expect(result.block).toBe(true);
  });

  it('blocks Write with no path', () => {
    const result = shouldBlockToolCall('Write', {});
    expect(result.block).toBe(true);
  });

  it('blocks Write with traversal path', () => {
    const result = shouldBlockToolCall('Write', { path: '../.flow/exploit.md' });
    expect(result.block).toBe(true);
  });
});
