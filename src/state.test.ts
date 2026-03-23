import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  findFlowDir,
  ensureFlowDir,
  ensureFeatureDir,
  readStateFile,
  writeStateFile,
  appendProgressLog,
  readPhaseFile,
  writePhaseFile,
  readFrontmatter,
  updateFrontmatter,
  writeCheckpoint,
  readCheckpoint,
  writeDispatchLog,
} from './state.js';
import type { FlowState } from './types.js';

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-flow-state-test-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ─── helpers ──────────────────────────────────────────────────────────────────

function makeState(overrides: Partial<FlowState> = {}): FlowState {
  return {
    feature: 'test-feature',
    change_type: 'feature',
    current_phase: 'intent',
    current_wave: null,
    wave_count: null,
    skipped_phases: [],
    started_at: '2026-01-01T00:00:00Z',
    last_updated: '2026-01-01T00:00:00Z',
    budget: { total_tokens: 0, total_cost_usd: 0 },
    gates: { spec_approved: false, design_approved: false, review_verdict: null },
    sentinel: { open_halts: 0, open_warns: 0 },
    ...overrides,
  };
}

// ─── findFlowDir ──────────────────────────────────────────────────────────────

describe('findFlowDir', () => {
  it('returns null when no .flow dir exists', () => {
    expect(findFlowDir(tmpDir)).toBeNull();
  });

  it('returns the .flow path when it exists in cwd', () => {
    fs.mkdirSync(path.join(tmpDir, '.flow'));
    expect(findFlowDir(tmpDir)).toBe(path.join(tmpDir, '.flow'));
  });

  it('finds .flow in a parent directory', () => {
    fs.mkdirSync(path.join(tmpDir, '.flow'));
    const child = path.join(tmpDir, 'subdir', 'deep');
    fs.mkdirSync(child, { recursive: true });
    expect(findFlowDir(child)).toBe(path.join(tmpDir, '.flow'));
  });
});

// ─── ensureFlowDir ────────────────────────────────────────────────────────────

describe('ensureFlowDir', () => {
  it('creates .flow dir and returns its path', () => {
    const result = ensureFlowDir(tmpDir);
    expect(result).toBe(path.join(tmpDir, '.flow'));
    expect(fs.existsSync(result)).toBe(true);
  });

  it('does not throw when .flow already exists', () => {
    ensureFlowDir(tmpDir);
    expect(() => ensureFlowDir(tmpDir)).not.toThrow();
  });
});

// ─── ensureFeatureDir ─────────────────────────────────────────────────────────

describe('ensureFeatureDir', () => {
  it('creates the feature dir and checkpoints subdir', () => {
    const result = ensureFeatureDir(tmpDir, 'my-feature');
    expect(result).toBe(path.join(tmpDir, '.flow', 'features', 'my-feature'));
    expect(fs.existsSync(result)).toBe(true);
    expect(fs.existsSync(path.join(result, 'checkpoints'))).toBe(true);
  });

  it('is idempotent — does not throw if dirs already exist', () => {
    ensureFeatureDir(tmpDir, 'my-feature');
    expect(() => ensureFeatureDir(tmpDir, 'my-feature')).not.toThrow();
  });
});

// ─── readStateFile ────────────────────────────────────────────────────────────

describe('readStateFile', () => {
  it('returns null when state.md does not exist', () => {
    const featureDir = path.join(tmpDir, 'no-state');
    fs.mkdirSync(featureDir);
    expect(readStateFile(featureDir)).toBeNull();
  });

  it('parses a valid state.md into FlowState', () => {
    const featureDir = ensureFeatureDir(tmpDir, 'test-feature');
    const state = makeState({
      current_phase: 'spec',
      budget: { total_tokens: 100, total_cost_usd: 0.5 },
    });
    writeStateFile(featureDir, state);

    const parsed = readStateFile(featureDir);
    expect(parsed).not.toBeNull();
    expect(parsed!.feature).toBe('test-feature');
    expect(parsed!.current_phase).toBe('spec');
    expect(parsed!.budget.total_tokens).toBe(100);
    expect(parsed!.budget.total_cost_usd).toBe(0.5);
  });

  it('returns null current_wave and wave_count when they are null', () => {
    const featureDir = ensureFeatureDir(tmpDir, 'test-feature');
    writeStateFile(featureDir, makeState({ current_wave: null, wave_count: null }));
    const parsed = readStateFile(featureDir);
    expect(parsed!.current_wave).toBeNull();
    expect(parsed!.wave_count).toBeNull();
  });

  it('returns numeric current_wave and wave_count', () => {
    const featureDir = ensureFeatureDir(tmpDir, 'test-feature');
    writeStateFile(featureDir, makeState({ current_wave: 2, wave_count: 4 }));
    const parsed = readStateFile(featureDir);
    expect(parsed!.current_wave).toBe(2);
    expect(parsed!.wave_count).toBe(4);
  });

  it('parses a non-empty skipped_phases array', () => {
    const featureDir = ensureFeatureDir(tmpDir, 'test-feature');
    writeStateFile(featureDir, makeState({ skipped_phases: ['spec', 'plan'] }));
    const parsed = readStateFile(featureDir);
    expect(parsed!.skipped_phases).toEqual(['spec', 'plan']);
  });

  it('parses an empty skipped_phases as an empty array', () => {
    const featureDir = ensureFeatureDir(tmpDir, 'test-feature');
    writeStateFile(featureDir, makeState({ skipped_phases: [] }));
    const parsed = readStateFile(featureDir);
    expect(parsed!.skipped_phases).toEqual([]);
  });

  it('parses gates with a string review_verdict', () => {
    const featureDir = ensureFeatureDir(tmpDir, 'test-feature');
    writeStateFile(
      featureDir,
      makeState({
        gates: { spec_approved: true, design_approved: true, review_verdict: 'PASSED' },
      }),
    );
    const parsed = readStateFile(featureDir);
    expect(parsed!.gates.spec_approved).toBe(true);
    expect(parsed!.gates.design_approved).toBe(true);
    expect(parsed!.gates.review_verdict).toBe('PASSED');
  });

  it('parses null review_verdict', () => {
    const featureDir = ensureFeatureDir(tmpDir, 'test-feature');
    writeStateFile(
      featureDir,
      makeState({ gates: { spec_approved: false, design_approved: false, review_verdict: null } }),
    );
    const parsed = readStateFile(featureDir);
    expect(parsed!.gates.review_verdict).toBeNull();
  });

  it('parses sentinel open_halts and open_warns', () => {
    const featureDir = ensureFeatureDir(tmpDir, 'test-feature');
    writeStateFile(
      featureDir,
      makeState({ sentinel: { open_halts: 2, open_warns: 3 } }),
    );
    const parsed = readStateFile(featureDir);
    expect(parsed!.sentinel.open_halts).toBe(2);
    expect(parsed!.sentinel.open_warns).toBe(3);
  });

  it('preserves the change_type field', () => {
    const featureDir = ensureFeatureDir(tmpDir, 'test-feature');
    writeStateFile(featureDir, makeState({ change_type: 'hotfix' }));
    const parsed = readStateFile(featureDir);
    expect(parsed!.change_type).toBe('hotfix');
  });
});

// ─── writeStateFile ───────────────────────────────────────────────────────────

describe('writeStateFile', () => {
  it('creates state.md with YAML frontmatter containing feature name', () => {
    const featureDir = ensureFeatureDir(tmpDir, 'my-feature');
    writeStateFile(featureDir, makeState({ feature: 'my-feature' }));
    const content = fs.readFileSync(path.join(featureDir, 'state.md'), 'utf8');
    expect(content).toContain('---');
    expect(content).toContain('feature: my-feature');
  });

  it('preserves existing progress log when re-writing state', () => {
    const featureDir = ensureFeatureDir(tmpDir, 'test-feature');
    writeStateFile(featureDir, makeState());

    const statePath = path.join(featureDir, 'state.md');
    const current = fs.readFileSync(statePath, 'utf8');
    fs.writeFileSync(statePath, current + '\n### 2026-01-01 00:00 — INTENT\nSome progress here.\n');

    writeStateFile(featureDir, makeState({ current_phase: 'spec' }));

    const updated = fs.readFileSync(statePath, 'utf8');
    expect(updated).toContain('Some progress here.');
    expect(updated).toContain('current_phase: spec');
  });

  it('writes a Progress Log section on first write', () => {
    const featureDir = ensureFeatureDir(tmpDir, 'test-feature');
    writeStateFile(featureDir, makeState());
    const content = fs.readFileSync(path.join(featureDir, 'state.md'), 'utf8');
    expect(content).toContain('Progress Log');
  });
});

// ─── appendProgressLog ────────────────────────────────────────────────────────

describe('appendProgressLog', () => {
  it('creates state.md when it does not exist', () => {
    const featureDir = ensureFeatureDir(tmpDir, 'test-feature');
    appendProgressLog(featureDir, 'intent', 'Started the workflow.');
    expect(fs.existsSync(path.join(featureDir, 'state.md'))).toBe(true);
  });

  it('appends the phase name (uppercased) and message to the log', () => {
    const featureDir = ensureFeatureDir(tmpDir, 'test-feature');
    writeStateFile(featureDir, makeState());
    appendProgressLog(featureDir, 'spec', 'Spec written and approved.');
    const content = fs.readFileSync(path.join(featureDir, 'state.md'), 'utf8');
    expect(content).toContain('SPEC');
    expect(content).toContain('Spec written and approved.');
  });

  it('appends multiple entries in order', () => {
    const featureDir = ensureFeatureDir(tmpDir, 'test-feature');
    writeStateFile(featureDir, makeState());
    appendProgressLog(featureDir, 'intent', 'First entry.');
    appendProgressLog(featureDir, 'spec', 'Second entry.');
    const content = fs.readFileSync(path.join(featureDir, 'state.md'), 'utf8');
    const firstIdx = content.indexOf('First entry.');
    const secondIdx = content.indexOf('Second entry.');
    expect(firstIdx).toBeGreaterThan(-1);
    expect(secondIdx).toBeGreaterThan(firstIdx);
  });
});

// ─── readPhaseFile ────────────────────────────────────────────────────────────

describe('readPhaseFile', () => {
  it('returns null when the file does not exist', () => {
    const featureDir = ensureFeatureDir(tmpDir, 'test-feature');
    expect(readPhaseFile(featureDir, 'spec.md')).toBeNull();
  });

  it('returns the content of an existing phase file', () => {
    const featureDir = ensureFeatureDir(tmpDir, 'test-feature');
    fs.writeFileSync(path.join(featureDir, 'spec.md'), '# Spec\nContent here.');
    expect(readPhaseFile(featureDir, 'spec.md')).toBe('# Spec\nContent here.');
  });
});

// ─── writePhaseFile ───────────────────────────────────────────────────────────

describe('writePhaseFile', () => {
  it('writes content to a file in the feature dir', () => {
    const featureDir = ensureFeatureDir(tmpDir, 'test-feature');
    writePhaseFile(featureDir, 'spec.md', '# Spec\nContent.');
    expect(fs.readFileSync(path.join(featureDir, 'spec.md'), 'utf8')).toBe('# Spec\nContent.');
  });

  it('creates parent directories as needed', () => {
    const featureDir = ensureFeatureDir(tmpDir, 'test-feature');
    writePhaseFile(featureDir, 'subdir/nested.md', 'Nested content.');
    expect(fs.existsSync(path.join(featureDir, 'subdir', 'nested.md'))).toBe(true);
  });
});

// ─── readFrontmatter ──────────────────────────────────────────────────────────

describe('readFrontmatter', () => {
  it('returns empty object for content without frontmatter', () => {
    expect(readFrontmatter('# Just a heading\nNo frontmatter.')).toEqual({});
  });

  it('returns empty object when content does not start with ---', () => {
    expect(readFrontmatter('key: value\n')).toEqual({});
  });

  it('returns key-value pairs as raw strings (no type coercion)', () => {
    const content = '---\nfeature: my-feature\napproved: true\ncount: 42\n---\n# Body';
    const fm = readFrontmatter(content);
    expect(fm['feature']).toBe('my-feature');
    expect(fm['approved']).toBe('true');  // string, not boolean
    expect(fm['count']).toBe('42');       // string, not number
  });

  it('skips lines with empty values', () => {
    const content = '---\nkey:\nother: value\n---\n';
    const fm = readFrontmatter(content);
    expect(fm['key']).toBeUndefined();
    expect(fm['other']).toBe('value');
  });

  it('returns empty object when frontmatter block is not closed', () => {
    const content = '---\nfeature: test\n';
    expect(readFrontmatter(content)).toEqual({});
  });
});

// ─── updateFrontmatter ────────────────────────────────────────────────────────

describe('updateFrontmatter', () => {
  it('updates an existing key in frontmatter', () => {
    const featureDir = ensureFeatureDir(tmpDir, 'test-feature');
    fs.writeFileSync(
      path.join(featureDir, 'spec.md'),
      '---\napproved: false\n---\n# Body\nContent.',
    );
    updateFrontmatter(featureDir, 'spec.md', { approved: 'true' });
    const content = fs.readFileSync(path.join(featureDir, 'spec.md'), 'utf8');
    expect(content).toContain('approved: true');
    expect(content).not.toContain('approved: false');
  });

  it('adds a new key that does not exist yet', () => {
    const featureDir = ensureFeatureDir(tmpDir, 'test-feature');
    fs.writeFileSync(
      path.join(featureDir, 'spec.md'),
      '---\nfeature: test\n---\n# Body',
    );
    updateFrontmatter(featureDir, 'spec.md', { approved: 'true' });
    const content = fs.readFileSync(path.join(featureDir, 'spec.md'), 'utf8');
    expect(content).toContain('approved: true');
    expect(content).toContain('feature: test');
  });

  it('preserves the body content after the frontmatter', () => {
    const featureDir = ensureFeatureDir(tmpDir, 'test-feature');
    fs.writeFileSync(
      path.join(featureDir, 'spec.md'),
      '---\napproved: false\n---\n# Spec Body\nImportant content.',
    );
    updateFrontmatter(featureDir, 'spec.md', { approved: 'true' });
    const content = fs.readFileSync(path.join(featureDir, 'spec.md'), 'utf8');
    expect(content).toContain('Important content.');
  });

  it('updates multiple keys in a single call', () => {
    const featureDir = ensureFeatureDir(tmpDir, 'test-feature');
    fs.writeFileSync(
      path.join(featureDir, 'design.md'),
      '---\napproved: false\nawaiting_approval: true\n---\n# Design',
    );
    updateFrontmatter(featureDir, 'design.md', {
      approved: 'true',
      awaiting_approval: 'false',
    });
    const content = fs.readFileSync(path.join(featureDir, 'design.md'), 'utf8');
    expect(content).toContain('approved: true');
    expect(content).toContain('awaiting_approval: false');
  });
});

// ─── writeCheckpoint ─────────────────────────────────────────────────────────

describe('writeCheckpoint', () => {
  it('writes a phase checkpoint XML (no wave)', () => {
    const featureDir = ensureFeatureDir(tmpDir, 'test-feature');
    writeCheckpoint(featureDir, 'spec', null, '<flow_resume/>');
    const filePath = path.join(featureDir, 'checkpoints', 'spec.xml');
    expect(fs.existsSync(filePath)).toBe(true);
    expect(fs.readFileSync(filePath, 'utf8')).toBe('<flow_resume/>');
  });

  it('includes the wave number in the filename when wave is provided', () => {
    const featureDir = ensureFeatureDir(tmpDir, 'test-feature');
    writeCheckpoint(featureDir, 'execute', 2, '<flow_resume wave="2"/>');
    const filePath = path.join(featureDir, 'checkpoints', 'execute-wave-2.xml');
    expect(fs.existsSync(filePath)).toBe(true);
  });

  it('copies checkpoint to latest.xml as a regular file (not a symlink)', () => {
    const featureDir = ensureFeatureDir(tmpDir, 'test-feature');
    writeCheckpoint(featureDir, 'spec', null, '<snapshot/>');
    const latestPath = path.join(featureDir, 'checkpoints', 'latest.xml');
    expect(fs.existsSync(latestPath)).toBe(true);
    expect(fs.lstatSync(latestPath).isSymbolicLink()).toBe(false);
    expect(fs.readFileSync(latestPath, 'utf8')).toBe('<snapshot/>');
  });

  it('latest.xml always reflects the most recent checkpoint', () => {
    const featureDir = ensureFeatureDir(tmpDir, 'test-feature');
    writeCheckpoint(featureDir, 'spec', null, 'checkpoint-1');
    writeCheckpoint(featureDir, 'analyze', null, 'checkpoint-2');
    const content = fs.readFileSync(
      path.join(featureDir, 'checkpoints', 'latest.xml'),
      'utf8',
    );
    expect(content).toBe('checkpoint-2');
  });

  it('creates the checkpoints dir if it does not exist yet', () => {
    const featureDir = path.join(tmpDir, '.flow', 'features', 'bare-feature');
    fs.mkdirSync(featureDir, { recursive: true });
    // intentionally no checkpoints/ subdir
    writeCheckpoint(featureDir, 'intent', null, '<data/>');
    expect(fs.existsSync(path.join(featureDir, 'checkpoints', 'intent.xml'))).toBe(true);
  });
});

// ─── readCheckpoint ───────────────────────────────────────────────────────────

describe('readCheckpoint', () => {
  it('returns null when no latest.xml exists', () => {
    const featureDir = ensureFeatureDir(tmpDir, 'test-feature');
    expect(readCheckpoint(featureDir)).toBeNull();
  });

  it('returns the content of latest.xml', () => {
    const featureDir = ensureFeatureDir(tmpDir, 'test-feature');
    writeCheckpoint(featureDir, 'spec', null, '<flow_resume>data</flow_resume>');
    expect(readCheckpoint(featureDir)).toBe('<flow_resume>data</flow_resume>');
  });
});

// ─── writeDispatchLog ─────────────────────────────────────────────────────────

describe('writeDispatchLog', () => {
  it('creates the dispatches dir if it does not exist', () => {
    const flowDir = ensureFlowDir(tmpDir);
    writeDispatchLog(flowDir, 'test-feature', { agent: 'builder', phase: 'execute' });
    expect(fs.existsSync(path.join(flowDir, 'dispatches'))).toBe(true);
  });

  it('creates a file containing the agent name and feature in its filename', () => {
    const flowDir = ensureFlowDir(tmpDir);
    writeDispatchLog(flowDir, 'my-feature', { agent: 'builder', phase: 'execute' });
    const files = fs.readdirSync(path.join(flowDir, 'dispatches'));
    expect(files.length).toBe(1);
    expect(files[0]).toContain('builder');
    expect(files[0]).toContain('my-feature');
  });

  it('writes entry data into the dispatch log file', () => {
    const flowDir = ensureFlowDir(tmpDir);
    writeDispatchLog(flowDir, 'test-feature', { agent: 'scout', phase: 'analyze', tokens: 5000 });
    const files = fs.readdirSync(path.join(flowDir, 'dispatches'));
    const content = fs.readFileSync(path.join(flowDir, 'dispatches', files[0]!), 'utf8');
    expect(content).toContain('scout');
    expect(content).toContain('5000');
  });

  it('uses unknown as the agent name when agent field is absent', () => {
    const flowDir = ensureFlowDir(tmpDir);
    writeDispatchLog(flowDir, 'test-feature', { phase: 'execute', tokens: 100 });
    const files = fs.readdirSync(path.join(flowDir, 'dispatches'));
    expect(files[0]).toContain('unknown');
  });
});
