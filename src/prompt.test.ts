import { describe, it, expect } from 'vitest';
import { buildCoordinatorPrompt, buildNudgeMessage } from './prompt.js';
import type { FlowAgentConfig, FlowState } from './types.js';

// ─── Fixtures ─────────────────────────────────────────────────────────────────

function makeAgent(overrides: Partial<FlowAgentConfig> & { name: string }): FlowAgentConfig {
  return {
    name: overrides.name,
    label: overrides.label ?? overrides.name,
    description: overrides.description ?? `The ${overrides.name} agent does things.`,
    model: 'claude-sonnet',
    thinking: 'none',
    tools: [],
    phases: overrides.phases ?? ['execute'],
    writable: false,
    temperament: 'balanced',
    limits: { max_tokens: 8000, max_steps: 10 },
    variables: [],
    systemPrompt: '',
    source: 'builtin',
    filePath: `/agents/${overrides.name}.md`,
  };
}

function makeState(overrides: Partial<FlowState> = {}): FlowState {
  return {
    feature: 'my-feature',
    change_type: 'feature',
    current_phase: 'execute',
    current_wave: null,
    wave_count: null,
    skipped_phases: [],
    started_at: '2024-01-01T00:00:00Z',
    last_updated: '2024-01-01T00:00:00Z',
    budget: { total_tokens: 0, total_cost_usd: 0 },
    gates: { spec_approved: false, design_approved: false, review_verdict: null },
    sentinel: { open_halts: 0, open_warns: 0 },
    ...overrides,
  };
}

const STANDARD_AGENTS: FlowAgentConfig[] = [
  makeAgent({ name: 'clarifier', phases: ['intent', 'spec'] }),
  makeAgent({ name: 'scout', phases: ['analyze', 'execute'] }),
  makeAgent({ name: 'strategist', phases: ['analyze'] }),
  makeAgent({ name: 'planner', phases: ['plan'] }),
  makeAgent({ name: 'builder', phases: ['execute'] }),
  makeAgent({ name: 'sentinel', phases: ['review'] }),
  makeAgent({ name: 'reviewer', phases: ['review'] }),
  makeAgent({ name: 'shipper', phases: ['ship'] }),
];

// ─── buildCoordinatorPrompt ───────────────────────────────────────────────────

describe('buildCoordinatorPrompt', () => {
  it('empty agents array → agent table contains header row only (no agent data rows)', () => {
    const output = buildCoordinatorPrompt([], null);
    expect(output).toContain('| Agent |');
    // Find the agent table separator and count rows until next blank line
    const lines = output.split('\n');
    const agentSepIdx = lines.findIndex((l) => l.startsWith('|---') && lines[l ? lines.indexOf(l) - 1 : 0]?.includes('Agent'));
    // No agent rows between separator and next non-table line
    let agentRows = 0;
    for (let i = agentSepIdx + 1; i < lines.length; i++) {
      if (!lines[i].startsWith('|')) break;
      agentRows++;
    }
    expect(agentRows).toBe(0);
  });

  it('8 standard agents → each agent name appears in output', () => {
    const output = buildCoordinatorPrompt(STANDARD_AGENTS, null);
    for (const agent of STANDARD_AGENTS) {
      expect(output).toContain(agent.name);
    }
  });

  it('agent description longer than 80 chars is truncated in the table', () => {
    const longDesc = 'A'.repeat(100) + '. Short sentence.';
    const agent = makeAgent({ name: 'verbose', description: longDesc });
    const output = buildCoordinatorPrompt([agent], null);
    // The first 80 chars of the description should appear, but the full 100 A's should not
    expect(output).toContain('A'.repeat(80));
    expect(output).not.toContain('A'.repeat(81));
  });

  it('16 agents → table contains exactly 15 agent rows plus "...and 1 more" line', () => {
    const agents = Array.from({ length: 16 }, (_, i) => makeAgent({ name: `agent${i}` }));
    const output = buildCoordinatorPrompt(agents, null);
    expect(output).toContain('...and 1 more');
    // Count agent table rows between separator and next non-table line
    const lines = output.split('\n');
    const headerIdx = lines.findIndex((l) => l.includes('| Agent |'));
    const sepIdx = headerIdx + 1; // separator follows header
    let agentRows = 0;
    for (let i = sepIdx + 1; i < lines.length; i++) {
      if (!lines[i].startsWith('|')) break;
      agentRows++;
    }
    expect(agentRows).toBe(15);
  });

  it('activeFeature=null → output does NOT contain "⚠️ Active:"', () => {
    const output = buildCoordinatorPrompt(STANDARD_AGENTS, null);
    expect(output).not.toContain('⚠️ Active:');
  });

  it('activeFeature with execute phase, wave 2/4 → output contains "execute" and "wave 2/4"', () => {
    const state = makeState({
      feature: 'auth-refresh',
      current_phase: 'execute',
      current_wave: 2,
      wave_count: 4,
    });
    const output = buildCoordinatorPrompt(STANDARD_AGENTS, {
      state,
      featureDir: '.flow/features/auth-refresh',
    });
    expect(output).toContain('execute');
    expect(output).toContain('wave 2/4');
    expect(output).toContain('⚠️ Active:');
  });

  it('activeFeature with 3 open HALTs → output contains "3 HALT"', () => {
    const state = makeState({
      sentinel: { open_halts: 3, open_warns: 0 },
    });
    const output = buildCoordinatorPrompt(STANDARD_AGENTS, {
      state,
      featureDir: '.flow/features/my-feature',
    });
    expect(output).toContain('3 HALT');
  });

  it('activeFeature with current_wave=null → no "wave" text in active section', () => {
    const state = makeState({
      current_wave: null,
      wave_count: null,
    });
    const output = buildCoordinatorPrompt(STANDARD_AGENTS, {
      state,
      featureDir: '.flow/features/my-feature',
    });
    expect(output).toContain('⚠️ Active:');
    // Extract just the active section line
    const activeLine = output.split('\n').find((l) => l.includes('⚠️ Active:')) ?? '';
    expect(activeLine).not.toContain('wave');
  });

  it('output contains all required sections', () => {
    const output = buildCoordinatorPrompt(STANDARD_AGENTS, null);
    expect(output).toContain('## Coordinator');
    expect(output).toContain('### Modes');
    expect(output).toContain('### Agents');
    expect(output).toContain('### Workflow');
    expect(output).toContain('### How to dispatch');
  });

  it('output contains delegation enforcement — dispatch only, no direct file access', () => {
    const output = buildCoordinatorPrompt(STANDARD_AGENTS, null);
    expect(output).toContain('dispatch_flow');
    // Must explicitly forbid direct tool use
    expect(output).toMatch(/never.*(Read|Write|Edit|Bash)/i);
    // Must forbid writing .flow/ artifacts
    expect(output).toMatch(/never.*write.*artifact/i);
  });

  it('output contains agent artifact ownership', () => {
    const output = buildCoordinatorPrompt(STANDARD_AGENTS, null);
    // Each agent writes its own artifacts
    expect(output).toContain('tasks.md');
    expect(output).toContain('design.md');
    expect(output).toContain('review.md');
  });

  it('output contains skip path table', () => {
    const output = buildCoordinatorPrompt(STANDARD_AGENTS, null);
    expect(output).toContain('feature');
    expect(output).toContain('refactor');
    expect(output).toContain('hotfix');
    expect(output).toContain('docs');
    expect(output).toContain('config');
    expect(output).toContain('research');
  });

  it('output contains human approval gate instructions', () => {
    const output = buildCoordinatorPrompt(STANDARD_AGENTS, null);
    expect(output).toContain('Human Approval');
    expect(output).toContain('NEVER self-approve');
    expect(output).toContain('approved: true');
  });

  it('output contains frontmatter format example with --- delimiters', () => {
    const output = buildCoordinatorPrompt(STANDARD_AGENTS, null);
    expect(output).toContain('---');
    expect(output).toContain('approved: true');
  });

  it('output contains scout enforcement instruction', () => {
    const output = buildCoordinatorPrompt(STANDARD_AGENTS, null);
    expect(output).toContain('scout');
    expect(output).toContain('analyze');
  });

  it('activeFeature includes action to dispatch agent for current phase', () => {
    const state = makeState({
      feature: 'auth',
      change_type: 'feature',
      current_phase: 'execute',
    });
    const output = buildCoordinatorPrompt(STANDARD_AGENTS, {
      state,
      featureDir: '.flow/features/auth',
    });
    expect(output).toContain('dispatch builder');
  });

  it('activeFeature at terminal phase shows complete message', () => {
    const state = makeState({
      feature: 'auth',
      change_type: 'feature',
      current_phase: 'ship',
    });
    const output = buildCoordinatorPrompt(STANDARD_AGENTS, {
      state,
      featureDir: '.flow/features/auth',
    });
    expect(output).toContain('complete');
  });
});

// ─── buildNudgeMessage ────────────────────────────────────────────────────────

describe('buildNudgeMessage', () => {
  it('returns string containing feature name', () => {
    const state = makeState({
      feature: 'payment-refactor',
      current_phase: 'plan',
    });
    const msg = buildNudgeMessage(state);
    expect(msg).toContain('payment-refactor');
  });

  it('tells coordinator to dispatch the agent for current phase (not the next one)', () => {
    const state = makeState({
      feature: 'auth-flow',
      change_type: 'feature',
      current_phase: 'review',
    });
    const msg = buildNudgeMessage(state);
    // current_phase = review → dispatch reviewer
    expect(msg).toContain('dispatch reviewer');
    expect(msg).not.toContain('shipper');
  });

  it('mentions approval when next phase requires it (spec → analyze)', () => {
    const state = makeState({
      feature: 'auth-flow',
      change_type: 'feature',
      current_phase: 'spec',
    });
    const msg = buildNudgeMessage(state);
    // next phase (analyze) requires spec approval
    expect(msg).toContain('approval');
    expect(msg).toContain('analyze');
  });

  it('mentions approval when next phase requires it (plan → execute)', () => {
    const state = makeState({
      feature: 'auth-flow',
      change_type: 'feature',
      current_phase: 'plan',
    });
    const msg = buildNudgeMessage(state);
    // next phase (execute) requires design approval
    expect(msg).toContain('approval');
    expect(msg).toContain('execute');
  });

  it('does not mention approval when next phase has no gate (execute → review)', () => {
    const state = makeState({
      feature: 'auth-flow',
      change_type: 'feature',
      current_phase: 'execute',
    });
    const msg = buildNudgeMessage(state);
    expect(msg).not.toContain('approval');
  });

  it('shows complete message at terminal phase', () => {
    const state = makeState({
      feature: 'auth-flow',
      change_type: 'feature',
      current_phase: 'ship',
    });
    const msg = buildNudgeMessage(state);
    expect(msg).toContain('complete');
  });

  it('returns complete message when current_phase is not in pipeline', () => {
    const state = makeState({
      feature: 'stale-feature',
      change_type: 'docs',
      current_phase: 'review', // not in docs pipeline
    });
    const msg = buildNudgeMessage(state);
    expect(msg).toContain('complete');
  });

  it('names the agent for the current phase, not the next', () => {
    const state = makeState({
      feature: 'fix-typo',
      change_type: 'feature',
      current_phase: 'execute',
    });
    const msg = buildNudgeMessage(state);
    expect(msg).toContain('dispatch builder');
    expect(msg).not.toContain('reviewer');
  });
});
