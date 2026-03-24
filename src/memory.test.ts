import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  ensureMemoryDir,
  appendDecision,
  appendPattern,
  appendLesson,
  readMemoryFile,
} from './memory.js';

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-flow-memory-test-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ─── ensureMemoryDir ──────────────────────────────────────────────────────────

describe('ensureMemoryDir', () => {
  it('creates .flow/memory/ if it does not exist', () => {
    const memDir = ensureMemoryDir(tmpDir);
    expect(fs.existsSync(memDir)).toBe(true);
    expect(memDir).toBe(path.join(tmpDir, 'memory'));
  });

  it('returns the memory dir path even when it already exists', () => {
    const memDir = ensureMemoryDir(tmpDir);
    const memDir2 = ensureMemoryDir(tmpDir);
    expect(memDir2).toBe(memDir);
    expect(fs.existsSync(memDir2)).toBe(true);
  });
});

// ─── appendDecision ───────────────────────────────────────────────────────────

describe('appendDecision', () => {
  it('creates decisions.md and writes the formatted entry', () => {
    appendDecision(tmpDir, {
      feature: 'auth-refresh',
      summary: 'Use Redis for token blacklist',
      approach: 'TTL-based eviction',
      outcome: 'PASSED review',
      date: '2026-03-24',
    });

    const decisionsPath = path.join(tmpDir, 'memory', 'decisions.md');
    expect(fs.existsSync(decisionsPath)).toBe(true);

    const content = fs.readFileSync(decisionsPath, 'utf8');
    expect(content).toContain('## auth-refresh — 2026-03-24');
    expect(content).toContain('**Decision:** Use Redis for token blacklist');
    expect(content).toContain('**Approach:** TTL-based eviction');
    expect(content).toContain('**Outcome:** PASSED review');
    expect(content).toContain('---');
  });

  it('appends multiple entries to decisions.md', () => {
    appendDecision(tmpDir, {
      feature: 'feature-a',
      summary: 'Summary A',
      approach: 'Approach A',
      outcome: 'Outcome A',
      date: '2026-03-24',
    });
    appendDecision(tmpDir, {
      feature: 'feature-b',
      summary: 'Summary B',
      approach: 'Approach B',
      outcome: 'Outcome B',
      date: '2026-03-25',
    });

    const content = fs.readFileSync(path.join(tmpDir, 'memory', 'decisions.md'), 'utf8');
    expect(content).toContain('## feature-a — 2026-03-24');
    expect(content).toContain('## feature-b — 2026-03-25');
  });
});

// ─── appendPattern ────────────────────────────────────────────────────────────

describe('appendPattern', () => {
  it('creates patterns.md and writes the formatted entry', () => {
    appendPattern(tmpDir, {
      name: 'Result<T> error propagation',
      description: 'All service methods return Result<T>.',
      files: ['src/auth/service.ts', 'src/payments/service.ts'],
      date: '2026-03-24',
    });

    const patternsPath = path.join(tmpDir, 'memory', 'patterns.md');
    expect(fs.existsSync(patternsPath)).toBe(true);

    const content = fs.readFileSync(patternsPath, 'utf8');
    expect(content).toContain('## Result<T> error propagation — first seen 2026-03-24');
    expect(content).toContain('All service methods return Result<T>.');
    expect(content).toContain('**Files:** src/auth/service.ts, src/payments/service.ts');
    expect(content).toContain('---');
  });

  it('appends multiple patterns', () => {
    appendPattern(tmpDir, {
      name: 'Pattern A',
      description: 'Desc A',
      files: ['a.ts'],
      date: '2026-03-24',
    });
    appendPattern(tmpDir, {
      name: 'Pattern B',
      description: 'Desc B',
      files: ['b.ts'],
      date: '2026-03-25',
    });

    const content = fs.readFileSync(path.join(tmpDir, 'memory', 'patterns.md'), 'utf8');
    expect(content).toContain('## Pattern A — first seen 2026-03-24');
    expect(content).toContain('## Pattern B — first seen 2026-03-25');
  });
});

// ─── appendLesson ─────────────────────────────────────────────────────────────

describe('appendLesson', () => {
  it('creates lessons.md and writes the formatted entry', () => {
    appendLesson(tmpDir, {
      title: 'Missing rate limit on mutations',
      description: 'Builder skipped rate limiting on POST /auth/refresh.',
      resolution: 'Add explicit task for WHILE-behaviors in Planner prompt.',
      date: '2026-03-24',
    });

    const lessonsPath = path.join(tmpDir, 'memory', 'lessons.md');
    expect(fs.existsSync(lessonsPath)).toBe(true);

    const content = fs.readFileSync(lessonsPath, 'utf8');
    expect(content).toContain('## Missing rate limit on mutations — 2026-03-24');
    expect(content).toContain('Builder skipped rate limiting on POST /auth/refresh.');
    expect(content).toContain(
      '**Resolution:** Add explicit task for WHILE-behaviors in Planner prompt.',
    );
    expect(content).toContain('---');
  });

  it('appends multiple lessons', () => {
    appendLesson(tmpDir, {
      title: 'Lesson A',
      description: 'Desc A',
      resolution: 'Fix A',
      date: '2026-03-24',
    });
    appendLesson(tmpDir, {
      title: 'Lesson B',
      description: 'Desc B',
      resolution: 'Fix B',
      date: '2026-03-25',
    });

    const content = fs.readFileSync(path.join(tmpDir, 'memory', 'lessons.md'), 'utf8');
    expect(content).toContain('## Lesson A — 2026-03-24');
    expect(content).toContain('## Lesson B — 2026-03-25');
  });
});

// ─── readMemoryFile ───────────────────────────────────────────────────────────

describe('readMemoryFile', () => {
  it('returns empty string when file does not exist', () => {
    const content = readMemoryFile(tmpDir, 'decisions.md');
    expect(content).toBe('');
  });

  it('returns file content when it exists', () => {
    ensureMemoryDir(tmpDir);
    fs.writeFileSync(path.join(tmpDir, 'memory', 'decisions.md'), 'hello memory');
    expect(readMemoryFile(tmpDir, 'decisions.md')).toBe('hello memory');
  });
});

