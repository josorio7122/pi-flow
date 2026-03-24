import { describe, it, expect } from 'vitest';

import { buildCoordinatorPrompt } from './prompt.js';
import type { FlowAgentConfig, FlowSkillConfig, FlowState } from './types.js';

function makeAgent(overrides: Partial<FlowAgentConfig> = {}): FlowAgentConfig {
  return {
    name: 'scout',
    label: 'Scout',
    description: 'Read-only codebase mapper. Reports what it finds.',
    model: 'claude-sonnet-4-6',
    thinking: 'low',
    tools: ['read', 'grep'],
    writable: false,
    limits: { max_tokens: 60000, max_steps: 80 },
    variables: [],
    writes: ['analysis.md'],
    systemPrompt: '# Scout',
    source: 'builtin',
    filePath: '/agents/scout.md',
    ...overrides,
  };
}

function makeSkill(overrides: Partial<FlowSkillConfig> = {}): FlowSkillConfig {
  return {
    name: 'forcing-questions',
    description: 'Ask questions before implementation.',
    body: '### Before starting\n\nAsk 5 questions.',
    source: 'builtin',
    filePath: '/skills/forcing-questions.md',
    ...overrides,
  };
}

describe('buildCoordinatorPrompt', () => {
  it('includes the Coordinator heading', () => {
    const prompt = buildCoordinatorPrompt([], [], null);
    expect(prompt).toContain('## Coordinator');
  });

  it('includes operating modes', () => {
    const prompt = buildCoordinatorPrompt([], [], null);
    expect(prompt).toContain('Just answer');
    expect(prompt).toContain('Quick fix');
    expect(prompt).toContain('Full feature');
  });

  it('includes full feature workflow steps', () => {
    const prompt = buildCoordinatorPrompt([], [], null);
    expect(prompt).toContain('Forcing questions');
    expect(prompt).toContain('Scout the codebase');
    expect(prompt).toContain('Design review');
    expect(prompt).toContain('Plan');
    expect(prompt).toContain('Build');
    expect(prompt).toContain('Review');
    expect(prompt).toContain('Ship');
  });

  it('includes task-writing rules', () => {
    const prompt = buildCoordinatorPrompt([], [], null);
    expect(prompt).toContain('How to write tasks');
    expect(prompt).toContain('NO access to your conversation');
    expect(prompt).toContain('What to do');
    expect(prompt).toContain('Boundaries');
    expect(prompt).toContain('Context');
    expect(prompt).toContain('Output format');
  });

  it('includes bad vs good task examples', () => {
    const prompt = buildCoordinatorPrompt([], [], null);
    expect(prompt).toContain('Bad:');
    expect(prompt).toContain('Good:');
  });

  it('includes dispatch syntax examples', () => {
    const prompt = buildCoordinatorPrompt([], [], null);
    expect(prompt).toContain('dispatch_flow');
    expect(prompt).toContain('parallel');
    expect(prompt).toContain('chain');
    expect(prompt).toContain('{previous}');
  });

  it('includes tool blocking rules', () => {
    const prompt = buildCoordinatorPrompt([], [], null);
    expect(prompt).toContain('blocked outside');
    expect(prompt).toContain('.flow/');
  });

  it('renders agent table with name, model, and description', () => {
    const agents = [makeAgent(), makeAgent({ name: 'builder', model: 'claude-sonnet-4-6', description: 'TDD practitioner.' })];
    const prompt = buildCoordinatorPrompt(agents, [], null);
    expect(prompt).toContain('| scout |');
    expect(prompt).toContain('| builder |');
    expect(prompt).toContain('claude-sonnet-4-6');
  });

  it('truncates long descriptions at first period', () => {
    const agent = makeAgent({ description: 'First sentence. Second sentence that is very long.' });
    const prompt = buildCoordinatorPrompt([agent], [], null);
    expect(prompt).toContain('First sentence');
    expect(prompt).not.toContain('Second sentence');
  });

  it('includes skill body content', () => {
    const skills = [makeSkill()];
    const prompt = buildCoordinatorPrompt([], skills, null);
    expect(prompt).toContain('Ask 5 questions');
  });

  it('includes multiple skills', () => {
    const skills = [
      makeSkill({ body: '### Skill A\n\nContent A' }),
      makeSkill({ name: 'skill-b', body: '### Skill B\n\nContent B' }),
    ];
    const prompt = buildCoordinatorPrompt([], skills, null);
    expect(prompt).toContain('Content A');
    expect(prompt).toContain('Content B');
  });

  it('omits active feature section when no feature', () => {
    const prompt = buildCoordinatorPrompt([], [], null);
    expect(prompt).not.toContain('Active Feature');
  });

  it('includes active feature with name, budget, and path', () => {
    const state: FlowState = {
      feature: 'auth-refresh',
      started_at: '2026-03-24T00:00:00Z',
      last_updated: '2026-03-24T01:00:00Z',
      budget: { total_tokens: 50000, total_cost_usd: 1.23 },
    };
    const prompt = buildCoordinatorPrompt([], [], { state, featureDir: '/tmp/.flow/features/auth-refresh' });
    expect(prompt).toContain('auth-refresh');
    expect(prompt).toContain('$1.23');
    expect(prompt).toContain('/tmp/.flow/features/auth-refresh');
  });
});
