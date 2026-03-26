import { describe, it, expect } from 'vitest';

import { requiresFeature, findAgent, resolveAgentTasks } from './dispatch.js';
import type { FlowAgentConfig } from './types.js';

function makeAgent(name: string): FlowAgentConfig {
  return {
    name,
    label: name,
    description: '',
    model: 'claude-sonnet-4-6',
    thinking: 'low',
    tools: ['read'],
    writable: false,
    limits: { max_tokens: 60000, max_steps: 80 },
    variables: [],
    writes: [],
    systemPrompt: '',
    source: 'builtin',
    filePath: '',
  };
}

describe('requiresFeature', () => {
  it('returns true for builder', () => {
    expect(requiresFeature('builder')).toBe(true);
  });

  it('returns true for test-writer', () => {
    expect(requiresFeature('test-writer')).toBe(true);
  });

  it('returns true for doc-writer', () => {
    expect(requiresFeature('doc-writer')).toBe(true);
  });

  it('returns true for planner', () => {
    expect(requiresFeature('planner')).toBe(true);
  });

  it('returns true for reviewer', () => {
    expect(requiresFeature('reviewer')).toBe(true);
  });

  it('returns false for scout', () => {
    expect(requiresFeature('scout')).toBe(false);
  });

  it('returns false for probe', () => {
    expect(requiresFeature('probe')).toBe(false);
  });

  it('returns false for unknown custom agents', () => {
    expect(requiresFeature('my-custom-agent')).toBe(false);
  });
});

describe('findAgent', () => {
  it('finds agent by name', () => {
    const agents = [makeAgent('scout'), makeAgent('builder')];
    expect(findAgent(agents, 'scout')?.name).toBe('scout');
  });

  it('returns null for missing agent', () => {
    expect(findAgent([makeAgent('scout')], 'probe')).toBeNull();
  });
});

describe('resolveAgentTasks', () => {
  it('resolves valid agent-task pairs', () => {
    const agents = [makeAgent('scout'), makeAgent('probe')];
    const result = resolveAgentTasks(
      [{ agent: 'scout', task: 'Map code' }, { agent: 'probe', task: 'Check DB' }],
      agents,
    );
    expect('resolved' in result).toBe(true);
    if ('resolved' in result) {
      expect(result.resolved).toHaveLength(2);
    }
  });

  it('returns error for unknown agent', () => {
    const result = resolveAgentTasks(
      [{ agent: 'nonexistent', task: 'task' }],
      [makeAgent('scout')],
    );
    expect('error' in result).toBe(true);
  });
});
