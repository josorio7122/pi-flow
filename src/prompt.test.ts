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
  it('empty agents array → table contains header row only (no agent data rows)', () => {
    const output = buildCoordinatorPrompt([], null);
    expect(output).toContain('| Agent |');
    // No agent name rows — split by newline and check no row after separator
    const lines = output.split('\n');
    const separatorIdx = lines.findIndex((l) => l.startsWith('|---'));
    // Everything after the separator until the next blank/non-table line should be empty
    const rowsAfterSeparator = lines.slice(separatorIdx + 1).filter((l) => l.startsWith('|'));
    expect(rowsAfterSeparator).toHaveLength(0);
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

  it('16 agents → table contains exactly 15 rows plus "...and 1 more" line', () => {
    const agents = Array.from({ length: 16 }, (_, i) => makeAgent({ name: `agent${i}` }));
    const output = buildCoordinatorPrompt(agents, null);
    expect(output).toContain('...and 1 more');
    // Count table data rows (lines starting with | that are not header or separator)
    const lines = output.split('\n');
    const separatorIdx = lines.findIndex((l) => l.startsWith('|---'));
    const dataRows = lines.slice(separatorIdx + 1).filter((l) => l.startsWith('|'));
    expect(dataRows).toHaveLength(15);
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
    expect(output).toContain('### Phase Pipeline');
    expect(output).toContain('### .flow/ Directory');
    expect(output).toContain('### Dispatch Rules');
  });
});

// ─── buildNudgeMessage ────────────────────────────────────────────────────────

describe('buildNudgeMessage', () => {
  it('returns string containing feature name and current_phase', () => {
    const state = makeState({
      feature: 'payment-refactor',
      current_phase: 'plan',
    });
    const msg = buildNudgeMessage(state);
    expect(msg).toContain('payment-refactor');
    expect(msg).toContain('plan');
  });

  it('contains a reference to the state.md file for the feature', () => {
    const state = makeState({ feature: 'auth-flow' });
    const msg = buildNudgeMessage(state);
    expect(msg).toContain('auth-flow');
    expect(msg).toContain('state.md');
  });
});
