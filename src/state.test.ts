import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

import {
  findFlowDir,
  ensureFeatureDir,
  readStateFile,
  writeStateFile,
  appendProgressLog,
  writeCheckpoint,
  writeDispatchLog,
} from './state.js';
import type { FlowState } from './types.js';

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-flow-state-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ─── findFlowDir ──────────────────────────────────────────────────────────────

describe('findFlowDir', () => {
  it('returns null when no .flow/ exists', () => {
    expect(findFlowDir(tmpDir)).toBeNull();
  });

  it('finds .flow/ in the given directory', () => {
    const flowDir = path.join(tmpDir, '.flow');
    fs.mkdirSync(flowDir);
    expect(findFlowDir(tmpDir)).toBe(flowDir);
  });

  it('walks up to find .flow/ in parent', () => {
    const flowDir = path.join(tmpDir, '.flow');
    fs.mkdirSync(flowDir);
    const subDir = path.join(tmpDir, 'src', 'deep');
    fs.mkdirSync(subDir, { recursive: true });
    expect(findFlowDir(subDir)).toBe(flowDir);
  });
});

// ─── ensureFeatureDir ─────────────────────────────────────────────────────────

describe('ensureFeatureDir', () => {
  it('creates .flow/features/<name>/checkpoints/', () => {
    const featureDir = ensureFeatureDir(tmpDir, 'auth-refresh');
    expect(fs.existsSync(featureDir)).toBe(true);
    expect(fs.existsSync(path.join(featureDir, 'checkpoints'))).toBe(true);
    expect(featureDir).toBe(path.join(tmpDir, '.flow', 'features', 'auth-refresh'));
  });
});

// ─── readStateFile / writeStateFile ───────────────────────────────────────────

describe('readStateFile + writeStateFile', () => {
  it('returns null for non-existent state.md', () => {
    expect(readStateFile(tmpDir)).toBeNull();
  });

  it('roundtrips a FlowState', () => {
    const featureDir = ensureFeatureDir(tmpDir, 'test');
    const state: FlowState = {
      feature: 'test',
      started_at: '2026-03-24T00:00:00Z',
      last_updated: '2026-03-24T01:00:00Z',
      budget: { total_tokens: 5000, total_cost_usd: 0.42 },
    };

    writeStateFile(featureDir, state);
    const loaded = readStateFile(featureDir);

    expect(loaded).not.toBeNull();
    expect(loaded!.feature).toBe('test');
    expect(loaded!.budget.total_tokens).toBe(5000);
    expect(loaded!.budget.total_cost_usd).toBe(0.42);
  });

  it('preserves progress log body on update', () => {
    const featureDir = ensureFeatureDir(tmpDir, 'test');
    const state: FlowState = {
      feature: 'test',
      started_at: '2026-03-24T00:00:00Z',
      last_updated: '2026-03-24T01:00:00Z',
      budget: { total_tokens: 0, total_cost_usd: 0 },
    };

    writeStateFile(featureDir, state);
    appendProgressLog(featureDir, 'dispatch: scout exit=0');

    const updated = { ...state, budget: { total_tokens: 5000, total_cost_usd: 0.5 } };
    writeStateFile(featureDir, updated);

    const content = fs.readFileSync(path.join(featureDir, 'state.md'), 'utf8');
    expect(content).toContain('budget_total_tokens: 5000');
    expect(content).toContain('dispatch: scout exit=0');
  });
});

// ─── appendProgressLog ────────────────────────────────────────────────────────

describe('appendProgressLog', () => {
  it('creates state.md if absent', () => {
    const featureDir = ensureFeatureDir(tmpDir, 'test');
    appendProgressLog(featureDir, 'first entry');
    const content = fs.readFileSync(path.join(featureDir, 'state.md'), 'utf8');
    expect(content).toContain('first entry');
    expect(content).toContain('Progress Log');
  });

  it('appends to existing state.md', () => {
    const featureDir = ensureFeatureDir(tmpDir, 'test');
    appendProgressLog(featureDir, 'entry one');
    appendProgressLog(featureDir, 'entry two');
    const content = fs.readFileSync(path.join(featureDir, 'state.md'), 'utf8');
    expect(content).toContain('entry one');
    expect(content).toContain('entry two');
  });
});

// ─── writeCheckpoint ──────────────────────────────────────────────────────────

describe('writeCheckpoint', () => {
  it('writes timestamped JSON and latest.json', () => {
    const featureDir = ensureFeatureDir(tmpDir, 'test');
    writeCheckpoint(featureDir, { agent: 'scout', exitCode: 0 });

    const checkpointsDir = path.join(featureDir, 'checkpoints');
    const files = fs.readdirSync(checkpointsDir);
    expect(files).toContain('latest.json');
    expect(files.length).toBe(2); // timestamp + latest

    const latest = JSON.parse(fs.readFileSync(path.join(checkpointsDir, 'latest.json'), 'utf8'));
    expect(latest.agent).toBe('scout');
    expect(latest.exitCode).toBe(0);
  });
});

// ─── writeDispatchLog ─────────────────────────────────────────────────────────

describe('writeDispatchLog', () => {
  it('writes a dispatch log file with frontmatter', () => {
    const flowDir = path.join(tmpDir, '.flow');
    fs.mkdirSync(flowDir, { recursive: true });

    writeDispatchLog(flowDir, 'auth-refresh', {
      agent: 'scout',
      task: 'Map auth module',
      exitCode: 0,
    });

    const dispatchesDir = path.join(flowDir, 'dispatches');
    const files = fs.readdirSync(dispatchesDir);
    expect(files.length).toBe(1);
    expect(files[0]).toContain('scout');
    expect(files[0]).toContain('auth-refresh');

    const content = fs.readFileSync(path.join(dispatchesDir, files[0]), 'utf8');
    expect(content).toContain('agent: "scout"');
    expect(content).toContain('exitCode: 0');
  });
});
