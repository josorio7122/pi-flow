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
  generateSessionId,
  ensureSessionDir,
  readSessionFile,
  writeSessionFile,
  writeFinding,
  writeSessionDispatchLog,
} from './state.js';
import type { FlowState, SessionState } from './types.js';

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

// ─── generateSessionId ───────────────────────────────────────────────────────

describe('generateSessionId', () => {
  it('returns a string matching s-YYYYMMDD-HHmmss-XXXX format', () => {
    const id = generateSessionId();
    expect(id).toMatch(/^s-\d{8}-\d{6}-[a-f0-9]{4}$/);
  });

  it('generates unique IDs on successive calls', () => {
    const ids = new Set(Array.from({ length: 20 }, () => generateSessionId()));
    expect(ids.size).toBe(20);
  });
});

// ─── ensureSessionDir ─────────────────────────────────────────────────────────

describe('ensureSessionDir', () => {
  it('creates .flow/sessions/<id>/findings/ and dispatches/', () => {
    const sessionId = 's-20260325-143012-a1b2';
    const sessionDir = ensureSessionDir(tmpDir, sessionId);

    expect(fs.existsSync(sessionDir)).toBe(true);
    expect(fs.existsSync(path.join(sessionDir, 'findings'))).toBe(true);
    expect(fs.existsSync(path.join(sessionDir, 'dispatches'))).toBe(true);
    expect(sessionDir).toBe(path.join(tmpDir, '.flow', 'sessions', sessionId));
  });
});

// ─── readSessionFile / writeSessionFile ───────────────────────────────────────

describe('readSessionFile + writeSessionFile', () => {
  it('returns null for non-existent session.md', () => {
    expect(readSessionFile(tmpDir)).toBeNull();
  });

  it('roundtrips a SessionState with feature', () => {
    const sessionDir = ensureSessionDir(tmpDir, 's-20260325-143012-a1b2');
    const state: SessionState = {
      session_id: 's-20260325-143012-a1b2',
      started_at: '2026-03-25T14:30:12Z',
      last_updated: '2026-03-25T14:35:00Z',
      feature: 'auth',
      budget: { total_tokens: 5000, total_cost_usd: 0.42 },
    };

    writeSessionFile(sessionDir, state);
    const loaded = readSessionFile(sessionDir);

    expect(loaded).not.toBeNull();
    expect(loaded!.session_id).toBe('s-20260325-143012-a1b2');
    expect(loaded!.feature).toBe('auth');
    expect(loaded!.budget.total_tokens).toBe(5000);
  });

  it('roundtrips a SessionState with null feature', () => {
    const sessionDir = ensureSessionDir(tmpDir, 's-20260325-143012-a1b2');
    const state: SessionState = {
      session_id: 's-20260325-143012-a1b2',
      started_at: '2026-03-25T14:30:12Z',
      last_updated: '2026-03-25T14:35:00Z',
      feature: null,
      budget: { total_tokens: 0, total_cost_usd: 0 },
    };

    writeSessionFile(sessionDir, state);
    const loaded = readSessionFile(sessionDir);

    expect(loaded).not.toBeNull();
    expect(loaded!.feature).toBeNull();
  });
});

// ─── writeFinding ─────────────────────────────────────────────────────────────

describe('writeFinding', () => {
  it('writes a finding file to sessions/<id>/findings/', () => {
    const sessionDir = ensureSessionDir(tmpDir, 's-20260325-143012-a1b2');

    writeFinding(sessionDir, 'scout', 'Map payment models', '## Found 5 models');

    const findingsDir = path.join(sessionDir, 'findings');
    const files = fs.readdirSync(findingsDir);
    expect(files.length).toBe(1);
    expect(files[0]).toContain('scout');

    const content = fs.readFileSync(path.join(findingsDir, files[0]), 'utf8');
    expect(content).toContain('## Found 5 models');
    expect(content).toContain('Map payment models');
  });

  it('writes multiple findings without overwriting', () => {
    const sessionDir = ensureSessionDir(tmpDir, 's-20260325-143012-a1b2');

    writeFinding(sessionDir, 'scout', 'Map models', 'output 1');
    writeFinding(sessionDir, 'probe', 'Check DB', 'output 2');

    const findingsDir = path.join(sessionDir, 'findings');
    const files = fs.readdirSync(findingsDir);
    expect(files.length).toBe(2);
  });
});

// ─── writeSessionDispatchLog ──────────────────────────────────────────────────

describe('writeSessionDispatchLog', () => {
  it('writes a dispatch log to sessions/<id>/dispatches/', () => {
    const sessionDir = ensureSessionDir(tmpDir, 's-20260325-143012-a1b2');

    writeSessionDispatchLog(sessionDir, {
      agent: 'scout',
      task: 'Map auth module',
      exitCode: 0,
    });

    const dispatchesDir = path.join(sessionDir, 'dispatches');
    const files = fs.readdirSync(dispatchesDir);
    expect(files.length).toBe(1);
    expect(files[0]).toContain('scout');

    const content = fs.readFileSync(path.join(dispatchesDir, files[0]), 'utf8');
    expect(content).toContain('agent: "scout"');
  });
});
