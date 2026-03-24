import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { writeArtifact } from './artifacts.js';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import type { FlowAgentConfig } from './types.js';

let featureDir: string;

function makeAgent(overrides: Partial<FlowAgentConfig> = {}): FlowAgentConfig {
  return {
    name: 'scout',
    label: 'Scout',
    description: '',
    model: 'claude-sonnet-4-6',
    thinking: 'low',
    tools: [],
    writable: false,
    limits: { max_tokens: 60000, max_steps: 80 },
    variables: [],
    writes: ['analysis.md'],
    systemPrompt: '',
    source: 'builtin',
    filePath: '',
    ...overrides,
  };
}

beforeEach(() => {
  featureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-flow-artifacts-'));
});

afterEach(() => {
  fs.rmSync(featureDir, { recursive: true, force: true });
});

describe('writeArtifact', () => {
  it('writes agent output to the first artifact in writes list', () => {
    const agent = makeAgent({ writes: ['analysis.md'] });
    writeArtifact(featureDir, agent, '## Results\nFound 5 models.', 'Map facility models');

    const content = fs.readFileSync(path.join(featureDir, 'analysis.md'), 'utf8');
    expect(content).toContain('Found 5 models');
  });

  it('does nothing when writes list is empty', () => {
    const agent = makeAgent({ writes: [] });
    writeArtifact(featureDir, agent, 'output', 'task');

    const files = fs.readdirSync(featureDir);
    expect(files).toHaveLength(0);
  });

  it('appends with domain header for scouts (parallel analysis)', () => {
    const agent = makeAgent({ name: 'scout', writes: ['analysis.md'] });

    writeArtifact(featureDir, agent, 'Models found: Facility, Location', 'Map models');
    writeArtifact(featureDir, agent, 'Views found: FacilityListView', 'Map views');

    const content = fs.readFileSync(path.join(featureDir, 'analysis.md'), 'utf8');
    expect(content).toContain('## Scout: Map models');
    expect(content).toContain('Models found: Facility');
    expect(content).toContain('## Scout: Map views');
    expect(content).toContain('Views found: FacilityListView');
  });

  it('overwrites for non-scout agents (planner, reviewer)', () => {
    const agent = makeAgent({ name: 'planner', writes: ['tasks.md'] });

    writeArtifact(featureDir, agent, 'First plan', 'Plan v1');
    writeArtifact(featureDir, agent, 'Second plan', 'Plan v2');

    const content = fs.readFileSync(path.join(featureDir, 'tasks.md'), 'utf8');
    expect(content).toBe('Second plan');
    expect(content).not.toContain('First plan');
  });

  it('skips artifact write for builder (builder writes code, not artifacts)', () => {
    const agent = makeAgent({ name: 'builder', writes: ['tasks.md'] });

    // Builder updates tasks.md checkboxes directly — the extension should not overwrite
    writeArtifact(featureDir, agent, 'builder output', 'Implement wave 1');

    const files = fs.readdirSync(featureDir);
    expect(files).toHaveLength(0);
  });

  it('creates featureDir if it does not exist', () => {
    const deepDir = path.join(featureDir, 'nested', 'deep');
    const agent = makeAgent({ writes: ['review.md'] });

    writeArtifact(deepDir, agent, 'Review output', 'Review');

    expect(fs.existsSync(path.join(deepDir, 'review.md'))).toBe(true);
  });
});
