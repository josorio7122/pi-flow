import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  parseAgentFile,
  validateAgent,
  discoverAgents,
  readAgentsMd,
  buildVariableMap,
  injectVariables,
  extractSection,
} from './agents.js';
import type { FlowAgentConfig } from './types.js';

// ─── helpers ────────────────────────────────────────────────────────────────

function writeMd(filePath: string, content: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, 'utf8');
}

function makeAgent(overrides: Partial<FlowAgentConfig> = {}): FlowAgentConfig {
  return {
    name: 'builder',
    label: 'Builder',
    description: 'Builds things',
    model: 'claude-sonnet-4-6',
    thinking: 'medium',
    tools: ['read', 'write', 'edit', 'bash'],
    writable: true,
    limits: { max_tokens: 100000, max_steps: 120 },
    variables: ['FEATURE_NAME'],
    writes: ['tasks.md'],
    systemPrompt: '# Builder\n\nYou build things.',
    source: 'builtin',
    filePath: '/fake/path/builder.md',
    ...overrides,
  };
}

// ─── extractSection ──────────────────────────────────────────────────────────

describe('extractSection', () => {
  const content = `# Document

## Goal

Build a JWT refresh system.

## Behaviors

WHEN user calls refresh, THE system SHALL issue new tokens.

## Contracts

Request: POST /auth/refresh
`;

  it('extracts section content by ## heading', () => {
    const result = extractSection(content, '## Goal');
    expect(result).toBe('Build a JWT refresh system.');
  });

  it('stops at the next ## heading', () => {
    const result = extractSection(content, '## Goal');
    expect(result).not.toContain('WHEN user calls refresh');
  });

  it('extracts section that is not the first one', () => {
    const result = extractSection(content, '## Behaviors');
    expect(result).toContain('WHEN user calls refresh');
    expect(result).not.toContain('Build a JWT refresh');
  });

  it('returns empty string when heading is not found', () => {
    const result = extractSection(content, '## Missing');
    expect(result).toBe('');
  });

  it('extracts section at end of file (no subsequent heading)', () => {
    const simple = '## Goal\n\nBuild it.\n';
    const result = extractSection(simple, '## Goal');
    expect(result).toBe('Build it.');
  });

  it('trims leading and trailing whitespace from result', () => {
    const padded = '## Goal\n\n\n  Build it.  \n\n';
    const result = extractSection(padded, '## Goal');
    expect(result).toBe('Build it.');
  });

  it('handles Wave headings (used for WAVE_TASKS)', () => {
    const tasks = `## Wave 1\n\n- [ ] task-1.1: Add model\n\n## Wave 2\n\n- [ ] task-2.1: Add tests\n`;
    const result = extractSection(tasks, '## Wave 1');
    expect(result).toContain('task-1.1');
    expect(result).not.toContain('task-2.1');
  });

  it('Wave 2 extracts correctly', () => {
    const tasks = `## Wave 1\n\n- task 1\n\n## Wave 2\n\n- task 2\n`;
    const result = extractSection(tasks, '## Wave 2');
    expect(result).toBe('- task 2');
  });
});

// ─── parseAgentFile ──────────────────────────────────────────────────────────

describe('parseAgentFile', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-flow-agents-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('parses basic scalar fields from frontmatter', () => {
    const filePath = path.join(tmpDir, 'scout.md');
    writeMd(
      filePath,
      `---
name: scout
label: Scout
model: claude-sonnet-4-6
thinking: low
writable: false
tools:
  - read
  - bash
  - analyze
limits:
  max_tokens: 60000
  max_steps: 80
variables:
  - FEATURE_NAME
---

# Scout Agent

You map codebases.
`,
    );

    const agent = parseAgentFile(filePath, 'builtin');
    expect(agent.name).toBe('scout');
    expect(agent.label).toBe('Scout');
    expect(agent.model).toBe('claude-sonnet-4-6');
    expect(agent.thinking).toBe('low');
    expect(agent.writable).toBe(false);
  });

  it('parses tools as YAML list', () => {
    const filePath = path.join(tmpDir, 'builder.md');
    writeMd(
      filePath,
      `---
name: builder
model: claude-sonnet-4-6
tools:
  - read
  - write
  - edit
  - bash
limits:
  max_tokens: 100000
  max_steps: 120
---

Body.
`,
    );

    const agent = parseAgentFile(filePath, 'builtin');
    expect(agent.tools).toEqual(['read', 'write', 'edit', 'bash']);
  });

  it('parses tools as comma-separated string', () => {
    const filePath = path.join(tmpDir, 'planner.md');
    writeMd(
      filePath,
      `---
name: planner
model: claude-sonnet-4-6
tools: read, grep, find
limits:
  max_tokens: 15000
  max_steps: 20
---

Body.
`,
    );

    const agent = parseAgentFile(filePath, 'builtin');
    expect(agent.tools).toEqual(['read', 'grep', 'find']);
  });

  it('parses writes as YAML list', () => {
    const filePath = path.join(tmpDir, 'scout.md');
    writeMd(
      filePath,
      `---
name: scout
model: claude-sonnet-4-6
tools:
  - read
writes:
  - analysis.md
limits:
  max_tokens: 60000
  max_steps: 80
---

Body.
`,
    );

    const agent = parseAgentFile(filePath, 'builtin');
    expect(agent.writes).toEqual(['analysis.md']);
  });

  it('parses nested limits field', () => {
    const filePath = path.join(tmpDir, 'agent.md');
    writeMd(
      filePath,
      `---
name: agent
model: claude-sonnet-4-6
tools:
  - read
  - execute
limits:
  max_tokens: 75000
  max_steps: 90
---

Body.
`,
    );

    const agent = parseAgentFile(filePath, 'builtin');
    expect(agent.limits.max_tokens).toBe(75000);
    expect(agent.limits.max_steps).toBe(90);
  });

  it('parses variables as YAML list', () => {
    const filePath = path.join(tmpDir, 'agent.md');
    writeMd(
      filePath,
      `---
name: agent
model: claude-sonnet-4-6
tools:
  - read
  - execute
limits:
  max_tokens: 10000
  max_steps: 10
variables:
  - FEATURE_NAME
  - WAVE_TASKS
  - SPEC_GOAL
---

Body.
`,
    );

    const agent = parseAgentFile(filePath, 'builtin');
    expect(agent.variables).toEqual(['FEATURE_NAME', 'WAVE_TASKS', 'SPEC_GOAL']);
  });

  it('parses variables as comma-separated string', () => {
    const filePath = path.join(tmpDir, 'agent.md');
    writeMd(
      filePath,
      `---
name: agent
model: claude-sonnet-4-6
tools: read
variables: FEATURE_NAME, SPEC_GOAL
limits:
  max_tokens: 10000
  max_steps: 10
---

Body.
`,
    );

    const agent = parseAgentFile(filePath, 'builtin');
    expect(agent.variables).toEqual(['FEATURE_NAME', 'SPEC_GOAL']);
  });

  it('sets systemPrompt from markdown body (after frontmatter)', () => {
    const filePath = path.join(tmpDir, 'agent.md');
    writeMd(
      filePath,
      `---
name: agent
model: claude-sonnet-4-6
tools:
  - read
  - execute
limits:
  max_tokens: 10000
  max_steps: 10
---

# Agent

You are the agent. Do things.
`,
    );

    const agent = parseAgentFile(filePath, 'builtin');
    expect(agent.systemPrompt).toContain('# Agent');
    expect(agent.systemPrompt).toContain('You are the agent. Do things.');
    // systemPrompt should NOT contain frontmatter
    expect(agent.systemPrompt).not.toContain('name: agent');
  });

  it('sets source and filePath correctly', () => {
    const filePath = path.join(tmpDir, 'agent.md');
    writeMd(
      filePath,
      `---
name: agent
model: claude-sonnet-4-6
tools:
  - read
  - execute
limits:
  max_tokens: 10000
  max_steps: 10
---

Body.
`,
    );

    const builtin = parseAgentFile(filePath, 'builtin');
    expect(builtin.source).toBe('builtin');
    expect(builtin.filePath).toBe(filePath);

    const custom = parseAgentFile(filePath, 'custom');
    expect(custom.source).toBe('custom');
  });

  it('defaults label to name when label is absent', () => {
    const filePath = path.join(tmpDir, 'agent.md');
    writeMd(
      filePath,
      `---
name: myagent
model: claude-sonnet-4-6
tools:
  - read
  - execute
limits:
  max_tokens: 10000
  max_steps: 10
---

Body.
`,
    );

    const agent = parseAgentFile(filePath, 'builtin');
    expect(agent.label).toBe('myagent');
  });

  it('parses folded description string (> syntax)', () => {
    const filePath = path.join(tmpDir, 'agent.md');
    writeMd(
      filePath,
      `---
name: agent
model: claude-sonnet-4-6
description: >
  This is a long description
  that spans multiple lines.
tools:
  - read
  - execute
limits:
  max_tokens: 10000
  max_steps: 10
---

Body.
`,
    );

    const agent = parseAgentFile(filePath, 'builtin');
    expect(agent.description).toContain('long description');
    expect(agent.description.length).toBeGreaterThan(0);
  });

  it('parses writable: true as boolean true', () => {
    const filePath = path.join(tmpDir, 'agent.md');
    writeMd(
      filePath,
      `---
name: agent
model: claude-sonnet-4-6
tools:
  - write
  - execute
writable: true
limits:
  max_tokens: 10000
  max_steps: 10
---

Body.
`,
    );

    const agent = parseAgentFile(filePath, 'builtin');
    expect(agent.writable).toBe(true);
  });

  it('defaults writable to false when not specified', () => {
    const filePath = path.join(tmpDir, 'agent.md');
    writeMd(
      filePath,
      `---
name: agent
model: claude-sonnet-4-6
tools:
  - read
  - execute
limits:
  max_tokens: 10000
  max_steps: 10
---

Body.
`,
    );

    const agent = parseAgentFile(filePath, 'builtin');
    expect(agent.writable).toBe(false);
  });

  it('parses memory: project from frontmatter', () => {
    const filePath = path.join(tmpDir, 'agent.md');
    writeMd(
      filePath,
      `---
name: builder
model: claude-sonnet-4-6
tools:
  - read
  - write
writable: true
memory: project
limits:
  max_tokens: 100000
  max_steps: 120
---

Body.
`,
    );

    const agent = parseAgentFile(filePath, 'builtin');
    expect(agent.memory).toBe('project');
  });

  it('parses memory: global from frontmatter', () => {
    const filePath = path.join(tmpDir, 'agent.md');
    writeMd(
      filePath,
      `---
name: reviewer
model: claude-sonnet-4-6
tools:
  - read
memory: global
limits:
  max_tokens: 60000
  max_steps: 80
---

Body.
`,
    );

    const agent = parseAgentFile(filePath, 'builtin');
    expect(agent.memory).toBe('global');
  });

  it('defaults memory to undefined when not specified', () => {
    const filePath = path.join(tmpDir, 'agent.md');
    writeMd(
      filePath,
      `---
name: agent
model: claude-sonnet-4-6
tools:
  - read
limits:
  max_tokens: 10000
  max_steps: 10
---

Body.
`,
    );

    const agent = parseAgentFile(filePath, 'builtin');
    expect(agent.memory).toBeUndefined();
  });

  it('ignores invalid memory values', () => {
    const filePath = path.join(tmpDir, 'agent.md');
    writeMd(
      filePath,
      `---
name: agent
model: claude-sonnet-4-6
tools:
  - read
memory: invalid
limits:
  max_tokens: 10000
  max_steps: 10
---

Body.
`,
    );

    const agent = parseAgentFile(filePath, 'builtin');
    expect(agent.memory).toBeUndefined();
  });
});

// ─── validateAgent ────────────────────────────────────────────────────────────

describe('validateAgent', () => {
  it('returns empty array for a fully valid agent', () => {
    const errors = validateAgent(makeAgent());
    expect(errors).toEqual([]);
  });

  it('returns error for missing name', () => {
    const errors = validateAgent(makeAgent({ name: '' }));
    expect(errors.some((e) => /name/i.test(e))).toBe(true);
  });

  it('returns error for missing model', () => {
    const errors = validateAgent(makeAgent({ model: '' }));
    expect(errors.some((e) => /model/i.test(e))).toBe(true);
  });

  it('returns error for empty tools array', () => {
    const errors = validateAgent(makeAgent({ tools: [] }));
    expect(errors.some((e) => /tools/i.test(e))).toBe(true);
  });

  it('returns error when model does not contain "claude"', () => {
    const errors = validateAgent(makeAgent({ model: 'gpt-4-turbo' }));
    expect(errors.some((e) => /model/i.test(e))).toBe(true);
  });

  it('accepts valid claude model variants', () => {
    const models = [
      'claude-sonnet-4-6',
      'claude-opus-4-6',
      'claude-haiku-4-5',
      'claude-3-5-sonnet-20241022',
    ];
    for (const model of models) {
      const errors = validateAgent(makeAgent({ model }));
      expect(errors.some((e) => /model/i.test(e))).toBe(false);
    }
  });

  it('returns error for unknown tool', () => {
    const errors = validateAgent(makeAgent({ tools: ['read', 'curl', 'bash'] }));
    expect(errors.some((e) => /curl/i.test(e))).toBe(true);
  });

  it('does not error for all allowed tools', () => {
    const allTools = ['read', 'write', 'edit', 'bash', 'grep', 'find', 'ls'];
    const errors = validateAgent(makeAgent({ tools: allTools, writable: true }));
    expect(errors.filter((e) => /unknown tool/i.test(e))).toHaveLength(0);
  });

  it('returns error when writable is false and tools include write', () => {
    const errors = validateAgent(makeAgent({ writable: false, tools: ['read', 'write'] }));
    expect(errors.some((e) => /write/i.test(e))).toBe(true);
  });

  it('returns error when writable is false and tools include edit', () => {
    const errors = validateAgent(makeAgent({ writable: false, tools: ['read', 'edit'] }));
    expect(errors.some((e) => /edit/i.test(e))).toBe(true);
  });

  it('allows write and edit when writable is true', () => {
    const errors = validateAgent(makeAgent({ writable: true, tools: ['read', 'write', 'edit'] }));
    expect(errors).toHaveLength(0);
  });

  it('allows read-only tools when writable is false', () => {
    const errors = validateAgent(
      makeAgent({ writable: false, tools: ['read', 'grep', 'find', 'ls', 'bash'] }),
    );
    expect(errors).toHaveLength(0);
  });
});

// ─── discoverAgents ───────────────────────────────────────────────────────────

describe('discoverAgents', () => {
  let extensionDir: string;
  let cwd: string;

  beforeEach(() => {
    extensionDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-flow-ext-'));
    cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-flow-cwd-'));
  });

  afterEach(() => {
    fs.rmSync(extensionDir, { recursive: true, force: true });
    fs.rmSync(cwd, { recursive: true, force: true });
  });

  it('returns empty array when extensionDir/agents/ does not exist', () => {
    const agents = discoverAgents(extensionDir, cwd);
    expect(agents).toEqual([]);
  });

  it('loads built-in agents from extensionDir/agents/', () => {
    const agentsDir = path.join(extensionDir, 'agents');
    fs.mkdirSync(agentsDir, { recursive: true });
    writeMd(
      path.join(agentsDir, 'scout.md'),
      `---
name: scout
model: claude-sonnet-4-6
tools:
  - read
  - analyze
limits:
  max_tokens: 60000
  max_steps: 80
---

Scout body.
`,
    );

    const agents = discoverAgents(extensionDir, cwd);
    expect(agents).toHaveLength(1);
    expect(agents[0].name).toBe('scout');
    expect(agents[0].source).toBe('builtin');
  });

  it('loads multiple built-in agents', () => {
    const agentsDir = path.join(extensionDir, 'agents');
    fs.mkdirSync(agentsDir);
    for (const name of ['builder', 'sentinel', 'reviewer']) {
      writeMd(
        path.join(agentsDir, `${name}.md`),
        `---
name: ${name}
model: claude-sonnet-4-6
tools:
  - read
  - execute
limits:
  max_tokens: 10000
  max_steps: 10
---

Body.
`,
      );
    }

    const agents = discoverAgents(extensionDir, cwd);
    expect(agents).toHaveLength(3);
    expect(agents.map((a) => a.name).sort()).toEqual(['builder', 'reviewer', 'sentinel']);
  });

  it('loads custom agents from .flow/agents/custom/ in cwd', () => {
    const customDir = path.join(cwd, '.flow', 'agents', 'custom');
    fs.mkdirSync(customDir, { recursive: true });
    writeMd(
      path.join(customDir, 'specialist.md'),
      `---
name: specialist
model: claude-sonnet-4-6
tools:
  - read
  - execute
limits:
  max_tokens: 10000
  max_steps: 10
---

Custom body.
`,
    );

    const agents = discoverAgents(extensionDir, cwd);
    expect(agents).toHaveLength(1);
    expect(agents[0].name).toBe('specialist');
    expect(agents[0].source).toBe('custom');
  });

  it('custom agent overrides built-in agent with same name', () => {
    const agentsDir = path.join(extensionDir, 'agents');
    fs.mkdirSync(agentsDir, { recursive: true });
    writeMd(
      path.join(agentsDir, 'builder.md'),
      `---
name: builder
model: claude-sonnet-4-6
tools:
  - read
  - execute
limits:
  max_tokens: 100000
  max_steps: 120
---

Builtin builder.
`,
    );

    const customDir = path.join(cwd, '.flow', 'agents', 'custom');
    fs.mkdirSync(customDir, { recursive: true });
    writeMd(
      path.join(customDir, 'builder.md'),
      `---
name: builder
model: claude-opus-4-6
tools:
  - read
  - write
  - edit
  - execute
writable: true
limits:
  max_tokens: 80000
  max_steps: 60
---

Custom builder.
`,
    );

    const agents = discoverAgents(extensionDir, cwd);
    const builder = agents.find((a) => a.name === 'builder');
    expect(builder).toBeDefined();
    expect(builder!.source).toBe('custom');
    expect(builder!.model).toBe('claude-opus-4-6');
    expect(builder!.systemPrompt).toContain('Custom builder.');
  });

  it('preserves built-in agents not overridden by custom', () => {
    const agentsDir = path.join(extensionDir, 'agents');
    fs.mkdirSync(agentsDir, { recursive: true });
    for (const name of ['builder', 'scout']) {
      writeMd(
        path.join(agentsDir, `${name}.md`),
        `---
name: ${name}
model: claude-sonnet-4-6
tools:
  - read
  - execute
limits:
  max_tokens: 10000
  max_steps: 10
---

Body.
`,
      );
    }

    const customDir = path.join(cwd, '.flow', 'agents', 'custom');
    fs.mkdirSync(customDir, { recursive: true });
    writeMd(
      path.join(customDir, 'builder.md'),
      `---
name: builder
model: claude-opus-4-6
tools:
  - read
  - execute
writable: false
limits:
  max_tokens: 10000
  max_steps: 10
---

Custom.
`,
    );

    const agents = discoverAgents(extensionDir, cwd);
    expect(agents).toHaveLength(2);
    const scout = agents.find((a) => a.name === 'scout');
    expect(scout!.source).toBe('builtin');
  });

  it('walks up from cwd to find .flow/agents/custom/', () => {
    // Custom dir is in a parent directory above cwd
    const parentDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-flow-parent-'));
    const nestedCwd = path.join(parentDir, 'nested', 'project');
    fs.mkdirSync(nestedCwd, { recursive: true });

    const customDir = path.join(parentDir, '.flow', 'agents', 'custom');
    fs.mkdirSync(customDir, { recursive: true });
    writeMd(
      path.join(customDir, 'specialist.md'),
      `---
name: specialist
model: claude-sonnet-4-6
tools:
  - read
  - execute
limits:
  max_tokens: 10000
  max_steps: 10
---

Body.
`,
    );

    const agents = discoverAgents(extensionDir, nestedCwd);
    expect(agents.find((a) => a.name === 'specialist')).toBeDefined();

    fs.rmSync(parentDir, { recursive: true, force: true });
  });
});

// ─── readAgentsMd ─────────────────────────────────────────────────────────────

describe('readAgentsMd', () => {
  let cwd: string;

  beforeEach(() => {
    cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-flow-agents-md-'));
  });

  afterEach(() => {
    fs.rmSync(cwd, { recursive: true, force: true });
  });

  it('includes project AGENTS.md from cwd when present', () => {
    writeMd(path.join(cwd, 'AGENTS.md'), '# Project Rules\n\nUse TypeScript.');
    const result = readAgentsMd(cwd);
    expect(result).toContain('Use TypeScript.');
  });

  it('includes project AGENTS.md from .pi/agent/AGENTS.md when direct file absent', () => {
    writeMd(path.join(cwd, '.pi', 'agent', 'AGENTS.md'), '# Alt Rules\n\nUse Python.');
    const result = readAgentsMd(cwd);
    expect(result).toContain('Use Python.');
  });

  it('prefers cwd/AGENTS.md over cwd/.pi/agent/AGENTS.md', () => {
    writeMd(path.join(cwd, 'AGENTS.md'), 'Direct AGENTS.md content.');
    writeMd(path.join(cwd, '.pi', 'agent', 'AGENTS.md'), 'Nested AGENTS.md content.');
    const result = readAgentsMd(cwd);
    expect(result).toContain('Direct AGENTS.md content.');
    // Only one of the two project paths should be included
    const directCount = (result.match(/Direct AGENTS\.md content\./g) ?? []).length;
    expect(directCount).toBe(1);
  });

  it('returns string containing project content (regardless of global)', () => {
    writeMd(path.join(cwd, 'AGENTS.md'), 'PROJECT_UNIQUE_CONTENT_XYZ');
    const result = readAgentsMd(cwd);
    expect(result).toContain('PROJECT_UNIQUE_CONTENT_XYZ');
  });

  it('uses separator between global and project content when both exist', () => {
    const globalPath = path.join(os.homedir(), '.pi', 'agent', 'AGENTS.md');
    const globalExists = fs.existsSync(globalPath);

    writeMd(path.join(cwd, 'AGENTS.md'), 'Project content here.');
    const result = readAgentsMd(cwd);

    if (globalExists) {
      // Both exist: result should have separator
      expect(result).toContain('---');
      expect(result).toContain('Project content here.');
    } else {
      expect(result).toContain('Project content here.');
    }
  });

  it('returns empty string when neither global nor project AGENTS.md exists', () => {
    const globalPath = path.join(os.homedir(), '.pi', 'agent', 'AGENTS.md');
    const globalExists = fs.existsSync(globalPath);
    // cwd has no AGENTS.md

    const result = readAgentsMd(cwd);

    if (globalExists) {
      // Can't test "empty" when global exists — just verify it's a string
      expect(typeof result).toBe('string');
    } else {
      expect(result).toBe('');
    }
  });
});

// ─── buildVariableMap ─────────────────────────────────────────────────────────

describe('buildVariableMap', () => {
  let cwd: string;
  let featureDir: string;

  beforeEach(() => {
    cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-flow-bvm-'));
    featureDir = path.join(cwd, '.flow', 'features', 'auth-refresh');
    fs.mkdirSync(featureDir, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(cwd, { recursive: true, force: true });
  });

  it('sets FEATURE_NAME from the basename of featureDir', () => {
    const map = buildVariableMap(cwd, featureDir);
    expect(map.FEATURE_NAME).toBe('auth-refresh');
  });

  it('includes AGENTS_MD in the variable map', () => {
    const map = buildVariableMap(cwd, featureDir);
    expect('AGENTS_MD' in map).toBe(true);
    expect(typeof map.AGENTS_MD).toBe('string');
  });

  it('reads SPEC_GOAL from spec.md Goal section', () => {
    writeMd(
      path.join(featureDir, 'spec.md'),
      `---
approved: true
---

## Goal

Build JWT refresh token rotation.

## Behaviors

WHEN user calls /auth/refresh...
`,
    );

    const map = buildVariableMap(cwd, featureDir);
    expect(map.SPEC_GOAL).toBe('Build JWT refresh token rotation.');
  });

  it('reads SPEC_BEHAVIORS from spec.md Behaviors section', () => {
    writeMd(
      path.join(featureDir, 'spec.md'),
      `## Goal

Goal.

## Behaviors

WHEN user calls /auth/refresh, THE system SHALL issue a new token.
`,
    );

    const map = buildVariableMap(cwd, featureDir);
    expect(map.SPEC_BEHAVIORS).toContain('/auth/refresh');
  });

  it('returns empty string for SPEC_GOAL when spec.md is missing', () => {
    const map = buildVariableMap(cwd, featureDir);
    expect(map.SPEC_GOAL).toBe('');
  });

  it('reads CHOSEN_APPROACH from design.md Decision section', () => {
    writeMd(
      path.join(featureDir, 'design.md'),
      `## Options

Option A or B.

## Decision

Use Approach B: Redis rotating blacklist.
`,
    );

    const map = buildVariableMap(cwd, featureDir);
    expect(map.CHOSEN_APPROACH).toContain('Approach B');
  });

  it('returns empty string for CHOSEN_APPROACH when design.md is missing', () => {
    const map = buildVariableMap(cwd, featureDir);
    expect(map.CHOSEN_APPROACH).toBe('');
  });

  it('reads WAVE_TASKS from current wave in tasks.md (state.current_wave)', () => {
    writeMd(
      path.join(featureDir, 'tasks.md'),
      `---
wave_count: 2
---

## Wave 1

- [ ] task-1.1: Add model

## Wave 2

- [ ] task-2.1: Add tests
`,
    );

    const map = buildVariableMap(cwd, featureDir);
    expect(map.WAVE_TASKS).toContain('task-1.1');
    expect(map.WAVE_TASKS).toContain('task-2.1');
  });

  it('reads memory files from .flow/memory/', () => {
    const memDir = path.join(cwd, '.flow', 'memory');
    fs.mkdirSync(memDir, { recursive: true });
    writeMd(path.join(memDir, 'decisions.md'), 'Decision: use Redis for caching.');
    writeMd(path.join(memDir, 'patterns.md'), 'Pattern: Result<T> everywhere.');
    writeMd(path.join(memDir, 'lessons.md'), 'Lesson: add rate limits early.');

    const map = buildVariableMap(cwd, featureDir);
    expect(map.MEMORY_DECISIONS).toContain('use Redis');
    expect(map.MEMORY_PATTERNS).toContain('Result<T>');
    expect(map.MEMORY_LESSONS).toContain('rate limits');
  });

  it('returns empty string for memory files when they do not exist', () => {
    const map = buildVariableMap(cwd, featureDir);
    expect(map.MEMORY_DECISIONS).toBe('');
    expect(map.MEMORY_PATTERNS).toBe('');
    expect(map.MEMORY_LESSONS).toBe('');
  });

  it('returns all string values (no undefined)', () => {
    const map = buildVariableMap(cwd, featureDir);
    for (const [key, value] of Object.entries(map)) {
      expect(typeof value, `Expected ${key} to be a string`).toBe('string');
    }
  });
});

// ─── injectVariables ──────────────────────────────────────────────────────────

describe('injectVariables', () => {
  it('replaces {{VAR}} in prompt for declared variable', () => {
    const prompt = 'Feature: {{FEATURE_NAME}} is being built.';
    const map = { FEATURE_NAME: 'auth-refresh' };
    const result = injectVariables(prompt, map, ['FEATURE_NAME']);
    expect(result).toBe('Feature: auth-refresh is being built.');
  });

  it('replaces multiple occurrences of the same variable', () => {
    const prompt = '{{X}} and {{X}} again.';
    const map = { X: 'hello' };
    const result = injectVariables(prompt, map, ['X']);
    expect(result).toBe('hello and hello again.');
  });

  it('replaces multiple different variables', () => {
    const prompt = 'Wave {{CURRENT_WAVE}} of {{TOTAL_WAVES}}.';
    const map = { CURRENT_WAVE: '2', TOTAL_WAVES: '4' };
    const result = injectVariables(prompt, map, ['CURRENT_WAVE', 'TOTAL_WAVES']);
    expect(result).toBe('Wave 2 of 4.');
  });

  it('leaves {{VAR}} unchanged when variable is not in agentVariables', () => {
    const prompt = 'Feature: {{FEATURE_NAME}}, Wave: {{CURRENT_WAVE}}.';
    const map = { FEATURE_NAME: 'auth', CURRENT_WAVE: '1' };
    // Only FEATURE_NAME is declared — CURRENT_WAVE should be left alone
    const result = injectVariables(prompt, map, ['FEATURE_NAME']);
    expect(result).toBe('Feature: auth, Wave: {{CURRENT_WAVE}}.');
  });

  it('replaces with empty string when variable is in agentVariables but not in map', () => {
    const prompt = 'Data: {{MISSING_VAR}} end.';
    const map = { FEATURE_NAME: 'auth' };
    const result = injectVariables(prompt, map, ['MISSING_VAR']);
    expect(result).toBe('Data:  end.');
  });

  it('does not replace variables not in agentVariables even if in map', () => {
    const prompt = 'Hello {{SECRET}}.';
    const map = { SECRET: 'world', FEATURE_NAME: 'auth' };
    const result = injectVariables(prompt, map, ['FEATURE_NAME']);
    expect(result).toBe('Hello {{SECRET}}.');
  });

  it('returns prompt unchanged when agentVariables is empty', () => {
    const prompt = 'Hello {{FEATURE_NAME}}.';
    const map = { FEATURE_NAME: 'auth' };
    const result = injectVariables(prompt, map, []);
    expect(result).toBe('Hello {{FEATURE_NAME}}.');
  });

  it('handles empty map gracefully', () => {
    const prompt = 'Hello {{X}}.';
    const result = injectVariables(prompt, {}, ['X']);
    expect(result).toBe('Hello .');
  });
});
