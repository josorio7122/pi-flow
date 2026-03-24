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
  searchMemory,
  writeBackMemory,
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
    expect(memDir).toBe(path.join(tmpDir, '.flow', 'memory'));
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

    const decisionsPath = path.join(tmpDir, '.flow', 'memory', 'decisions.md');
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

    const content = fs.readFileSync(path.join(tmpDir, '.flow', 'memory', 'decisions.md'), 'utf8');
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

    const patternsPath = path.join(tmpDir, '.flow', 'memory', 'patterns.md');
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

    const content = fs.readFileSync(path.join(tmpDir, '.flow', 'memory', 'patterns.md'), 'utf8');
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

    const lessonsPath = path.join(tmpDir, '.flow', 'memory', 'lessons.md');
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

    const content = fs.readFileSync(path.join(tmpDir, '.flow', 'memory', 'lessons.md'), 'utf8');
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
    fs.writeFileSync(path.join(tmpDir, '.flow', 'memory', 'decisions.md'), 'hello memory');
    expect(readMemoryFile(tmpDir, 'decisions.md')).toBe('hello memory');
  });
});

// ─── searchMemory ─────────────────────────────────────────────────────────────

describe('searchMemory', () => {
  it('returns empty string when no memory files exist', () => {
    const result = searchMemory(tmpDir, 'redis');
    expect(result).toBe('');
  });

  it('returns matching sections ranked by keyword hits', () => {
    ensureMemoryDir(tmpDir);
    // Write a decisions.md with two sections
    fs.writeFileSync(
      path.join(tmpDir, '.flow', 'memory', 'decisions.md'),
      [
        '## auth-refresh — 2026-03-24',
        '**Decision:** Use Redis for token blacklist',
        '**Approach:** Redis TTL-based eviction',
        '**Outcome:** PASSED',
        '---',
        '## payment-flow — 2026-03-25',
        '**Decision:** Stripe webhooks',
        '**Approach:** Queue-based processing',
        '**Outcome:** PASSED',
        '---',
      ].join('\n'),
    );

    // "redis" appears twice in the first section → should be ranked first
    const result = searchMemory(tmpDir, 'redis');
    expect(result).toContain('auth-refresh');
    // payment section has 0 redis matches so not included in top 1
    expect(result).not.toContain('payment-flow');
  });

  it('searches across all three memory files', () => {
    ensureMemoryDir(tmpDir);
    fs.writeFileSync(
      path.join(tmpDir, '.flow', 'memory', 'decisions.md'),
      '## decision-section — 2026-03-24\nsome content here\n---\n',
    );
    fs.writeFileSync(
      path.join(tmpDir, '.flow', 'memory', 'patterns.md'),
      '## pattern-section — first seen 2026-03-24\nsome pattern content\n---\n',
    );
    fs.writeFileSync(
      path.join(tmpDir, '.flow', 'memory', 'lessons.md'),
      '## lesson-section — 2026-03-24\nsome lesson content\n---\n',
    );

    const result = searchMemory(tmpDir, 'some', 3);
    expect(result).toContain('decision-section');
    expect(result).toContain('pattern-section');
    expect(result).toContain('lesson-section');
  });

  it('respects maxResults limit', () => {
    ensureMemoryDir(tmpDir);
    const sections = Array.from({ length: 5 }, (_, i) =>
      [`## section-${i} — 2026-03-24`, `content keyword`, '---'].join('\n'),
    ).join('\n');
    fs.writeFileSync(path.join(tmpDir, '.flow', 'memory', 'decisions.md'), sections);

    const result = searchMemory(tmpDir, 'keyword', 2);
    const matches = result.match(/## section-/g) ?? [];
    expect(matches.length).toBe(2);
  });

  it('returns empty string when query has no matches', () => {
    ensureMemoryDir(tmpDir);
    fs.writeFileSync(
      path.join(tmpDir, '.flow', 'memory', 'decisions.md'),
      '## some-feature — 2026-03-24\nsome content\n---\n',
    );
    const result = searchMemory(tmpDir, 'zzznomatch');
    expect(result).toBe('');
  });

  it('defaults to maxResults = 3', () => {
    ensureMemoryDir(tmpDir);
    const sections = Array.from({ length: 5 }, (_, i) =>
      [`## section-${i} — 2026-03-24`, `content keyword`, '---'].join('\n'),
    ).join('\n');
    fs.writeFileSync(path.join(tmpDir, '.flow', 'memory', 'decisions.md'), sections);

    const result = searchMemory(tmpDir, 'keyword');
    const matches = result.match(/## section-/g) ?? [];
    expect(matches.length).toBe(3);
  });
});

// ─── writeBackMemory ──────────────────────────────────────────────────────────

describe('writeBackMemory', () => {
  it('does nothing when ship-log.md does not exist', () => {
    const featureDir = path.join(tmpDir, '.flow', 'features', 'my-feature');
    fs.mkdirSync(featureDir, { recursive: true });

    writeBackMemory(tmpDir, featureDir);

    const memDir = path.join(tmpDir, '.flow', 'memory');
    expect(fs.existsSync(path.join(memDir, 'decisions.md'))).toBe(false);
  });

  it('extracts and appends the Decisions section from ship-log.md', () => {
    const featureDir = path.join(tmpDir, '.flow', 'features', 'my-feature');
    fs.mkdirSync(featureDir, { recursive: true });

    fs.writeFileSync(
      path.join(featureDir, 'ship-log.md'),
      [
        '---',
        'feature: my-feature',
        'shipped_at: 2026-03-24',
        '---',
        '',
        '# Ship Log: My Feature',
        '',
        '## Decisions',
        'Used Redis for caching with TTL strategy.',
        '',
        '## CI',
        'Status: passing',
      ].join('\n'),
    );

    writeBackMemory(tmpDir, featureDir);

    const decisionsContent = fs.readFileSync(
      path.join(tmpDir, '.flow', 'memory', 'decisions.md'),
      'utf8',
    );
    expect(decisionsContent).toContain('Redis');
  });

  it('extracts and appends the Patterns section from ship-log.md', () => {
    const featureDir = path.join(tmpDir, '.flow', 'features', 'my-feature');
    fs.mkdirSync(featureDir, { recursive: true });

    fs.writeFileSync(
      path.join(featureDir, 'ship-log.md'),
      [
        '# Ship Log',
        '## Patterns',
        'Result<T> used throughout service layer.',
        '## CI',
        'passing',
      ].join('\n'),
    );

    writeBackMemory(tmpDir, featureDir);

    const patternsContent = fs.readFileSync(
      path.join(tmpDir, '.flow', 'memory', 'patterns.md'),
      'utf8',
    );
    expect(patternsContent).toContain('Result<T>');
  });

  it('extracts and appends the Lessons section from ship-log.md', () => {
    const featureDir = path.join(tmpDir, '.flow', 'features', 'my-feature');
    fs.mkdirSync(featureDir, { recursive: true });

    fs.writeFileSync(
      path.join(featureDir, 'ship-log.md'),
      [
        '# Ship Log',
        '## Lessons',
        'Always add rate limits to mutation endpoints.',
        '## CI',
        'passing',
      ].join('\n'),
    );

    writeBackMemory(tmpDir, featureDir);

    const lessonsContent = fs.readFileSync(
      path.join(tmpDir, '.flow', 'memory', 'lessons.md'),
      'utf8',
    );
    expect(lessonsContent).toContain('rate limits');
  });

  it('skips sections not present in ship-log.md', () => {
    const featureDir = path.join(tmpDir, '.flow', 'features', 'my-feature');
    fs.mkdirSync(featureDir, { recursive: true });

    fs.writeFileSync(
      path.join(featureDir, 'ship-log.md'),
      ['# Ship Log', '## CI', 'passing'].join('\n'),
    );

    writeBackMemory(tmpDir, featureDir);

    const memDir = path.join(tmpDir, '.flow', 'memory');
    expect(fs.existsSync(path.join(memDir, 'decisions.md'))).toBe(false);
    expect(fs.existsSync(path.join(memDir, 'patterns.md'))).toBe(false);
    expect(fs.existsSync(path.join(memDir, 'lessons.md'))).toBe(false);
  });
});
