import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  isUnsafeName,
  isSymlink,
  safeReadFile,
  resolveMemoryDir,
  ensureMemoryDir,
  readMemoryIndex,
  buildMemoryBlock,
  buildReadOnlyMemoryBlock,
  MAX_MEMORY_LINES,
} from './memory.js';

// ─── Test helpers ─────────────────────────────────────────────────────────────

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-test-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ─── isUnsafeName ─────────────────────────────────────────────────────────────

describe('isUnsafeName', () => {
  it('returns false for valid names', () => {
    expect(isUnsafeName('scout')).toBe(false);
    expect(isUnsafeName('test-writer')).toBe(false);
    expect(isUnsafeName('my_agent.v2')).toBe(false);
    expect(isUnsafeName('Agent1')).toBe(false);
  });

  it('returns true for empty string', () => {
    expect(isUnsafeName('')).toBe(true);
  });

  it('returns true for names exceeding 128 chars', () => {
    expect(isUnsafeName('a'.repeat(129))).toBe(true);
  });

  it('returns true for names with path traversal', () => {
    expect(isUnsafeName('../etc/passwd')).toBe(true);
    expect(isUnsafeName('agent/../../root')).toBe(true);
  });

  it('returns true for names starting with a dot', () => {
    expect(isUnsafeName('.hidden')).toBe(true);
  });

  it('returns true for names with spaces or special chars', () => {
    expect(isUnsafeName('my agent')).toBe(true);
    expect(isUnsafeName('agent@name')).toBe(true);
    expect(isUnsafeName('agent;rm -rf')).toBe(true);
  });
});

// ─── isSymlink ────────────────────────────────────────────────────────────────

describe('isSymlink', () => {
  it('returns false for regular files', () => {
    const filePath = path.join(tmpDir, 'regular.txt');
    fs.writeFileSync(filePath, 'content');
    expect(isSymlink(filePath)).toBe(false);
  });

  it('returns true for symlinks', () => {
    const target = path.join(tmpDir, 'target.txt');
    const link = path.join(tmpDir, 'link.txt');
    fs.writeFileSync(target, 'content');
    fs.symlinkSync(target, link);
    expect(isSymlink(link)).toBe(true);
  });

  it('returns false for non-existent paths', () => {
    expect(isSymlink(path.join(tmpDir, 'missing.txt'))).toBe(false);
  });

  it('returns false for directories', () => {
    const dir = path.join(tmpDir, 'subdir');
    fs.mkdirSync(dir);
    expect(isSymlink(dir)).toBe(false);
  });
});

// ─── safeReadFile ─────────────────────────────────────────────────────────────

describe('safeReadFile', () => {
  it('reads regular files', () => {
    const filePath = path.join(tmpDir, 'hello.txt');
    fs.writeFileSync(filePath, 'hello world');
    expect(safeReadFile(filePath)).toBe('hello world');
  });

  it('returns undefined for non-existent files', () => {
    expect(safeReadFile(path.join(tmpDir, 'missing.txt'))).toBeUndefined();
  });

  it('returns undefined for symlinks', () => {
    const target = path.join(tmpDir, 'target.txt');
    const link = path.join(tmpDir, 'link.txt');
    fs.writeFileSync(target, 'secret');
    fs.symlinkSync(target, link);
    expect(safeReadFile(link)).toBeUndefined();
  });
});

// ─── resolveMemoryDir ─────────────────────────────────────────────────────────

describe('resolveMemoryDir', () => {
  it('resolves project scope to .flow/agent-memory/{name}', () => {
    const result = resolveMemoryDir('scout', 'project', '/my/project');
    expect(result).toBe(path.join('/my/project', '.flow', 'agent-memory', 'scout'));
  });

  it('resolves global scope to ~/.pi/flow-memory/{name}', () => {
    const result = resolveMemoryDir('reviewer', 'global', '/my/project');
    expect(result).toBe(path.join(os.homedir(), '.pi', 'flow-memory', 'reviewer'));
  });

  it('throws for unsafe agent names', () => {
    expect(() => resolveMemoryDir('../etc', 'project', '/my/project')).toThrow('Unsafe agent name');
    expect(() => resolveMemoryDir('', 'project', '/my/project')).toThrow('Unsafe agent name');
  });
});

// ─── ensureMemoryDir ──────────────────────────────────────────────────────────

describe('ensureMemoryDir', () => {
  it('creates the directory recursively', () => {
    const dir = path.join(tmpDir, 'a', 'b', 'c');
    ensureMemoryDir(dir);
    expect(fs.existsSync(dir)).toBe(true);
    expect(fs.statSync(dir).isDirectory()).toBe(true);
  });

  it('is idempotent for existing directories', () => {
    const dir = path.join(tmpDir, 'existing');
    fs.mkdirSync(dir);
    ensureMemoryDir(dir);
    expect(fs.existsSync(dir)).toBe(true);
  });

  it('throws if path is a symlink', () => {
    const realDir = path.join(tmpDir, 'real');
    const linkDir = path.join(tmpDir, 'symlink-dir');
    fs.mkdirSync(realDir);
    fs.symlinkSync(realDir, linkDir);
    expect(() => ensureMemoryDir(linkDir)).toThrow('symlinked memory directory');
  });
});

// ─── readMemoryIndex ──────────────────────────────────────────────────────────

describe('readMemoryIndex', () => {
  it('returns undefined when MEMORY.md does not exist', () => {
    const dir = path.join(tmpDir, 'empty-agent');
    fs.mkdirSync(dir, { recursive: true });
    expect(readMemoryIndex(dir)).toBeUndefined();
  });

  it('reads MEMORY.md contents', () => {
    const dir = path.join(tmpDir, 'agent');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'MEMORY.md'), '# My memories\n\n- learned X');
    expect(readMemoryIndex(dir)).toBe('# My memories\n\n- learned X');
  });

  it('truncates MEMORY.md at MAX_MEMORY_LINES', () => {
    const dir = path.join(tmpDir, 'agent-big');
    fs.mkdirSync(dir, { recursive: true });
    const lines = Array.from({ length: MAX_MEMORY_LINES + 50 }, (_, i) => `Line ${i + 1}`);
    fs.writeFileSync(path.join(dir, 'MEMORY.md'), lines.join('\n'));

    const result = readMemoryIndex(dir);
    expect(result).toContain('Line 1');
    expect(result).toContain(`Line ${MAX_MEMORY_LINES}`);
    expect(result).not.toContain(`Line ${MAX_MEMORY_LINES + 1}`);
    expect(result).toContain('truncated');
  });

  it('returns undefined if memory dir is a symlink', () => {
    const realDir = path.join(tmpDir, 'real-agent');
    const linkDir = path.join(tmpDir, 'link-agent');
    fs.mkdirSync(realDir, { recursive: true });
    fs.writeFileSync(path.join(realDir, 'MEMORY.md'), 'secret');
    fs.symlinkSync(realDir, linkDir);
    expect(readMemoryIndex(linkDir)).toBeUndefined();
  });

  it('returns full content when exactly at MAX_MEMORY_LINES', () => {
    const dir = path.join(tmpDir, 'agent-exact');
    fs.mkdirSync(dir, { recursive: true });
    const lines = Array.from({ length: MAX_MEMORY_LINES }, (_, i) => `Line ${i + 1}`);
    fs.writeFileSync(path.join(dir, 'MEMORY.md'), lines.join('\n'));

    const result = readMemoryIndex(dir);
    expect(result).not.toContain('truncated');
    expect(result).toContain(`Line ${MAX_MEMORY_LINES}`);
  });
});

// ─── buildMemoryBlock ─────────────────────────────────────────────────────────

describe('buildMemoryBlock', () => {
  it('includes the memory directory path', () => {
    const cwd = tmpDir;
    const result = buildMemoryBlock('builder', 'project', cwd);
    expect(result).toContain(path.join(cwd, '.flow', 'agent-memory', 'builder'));
  });

  it('creates the memory directory', () => {
    const cwd = tmpDir;
    buildMemoryBlock('builder', 'project', cwd);
    const dir = path.join(cwd, '.flow', 'agent-memory', 'builder');
    expect(fs.existsSync(dir)).toBe(true);
  });

  it('includes existing MEMORY.md contents', () => {
    const cwd = tmpDir;
    const dir = path.join(cwd, '.flow', 'agent-memory', 'builder');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'MEMORY.md'), '# Builder notes\n\n- use barrel imports');

    const result = buildMemoryBlock('builder', 'project', cwd);
    expect(result).toContain('# Builder notes');
    expect(result).toContain('use barrel imports');
  });

  it('includes write instructions', () => {
    const cwd = tmpDir;
    const result = buildMemoryBlock('builder', 'project', cwd);
    expect(result).toContain('MEMORY.md');
    expect(result).toContain('Memory Instructions');
    expect(result).toContain('under 200 lines');
  });

  it('mentions scope in the block', () => {
    const cwd = tmpDir;
    const result = buildMemoryBlock('builder', 'project', cwd);
    expect(result).toContain('project');
  });

  it('handles global scope', () => {
    const result = buildMemoryBlock('reviewer', 'global', tmpDir);
    expect(result).toContain(path.join(os.homedir(), '.pi', 'flow-memory', 'reviewer'));
  });

  it('shows no-memory message when MEMORY.md does not exist', () => {
    const cwd = tmpDir;
    const result = buildMemoryBlock('planner', 'project', cwd);
    expect(result).toContain('No MEMORY.md exists yet');
  });
});

// ─── buildReadOnlyMemoryBlock ─────────────────────────────────────────────────

describe('buildReadOnlyMemoryBlock', () => {
  it('includes read-only label', () => {
    const result = buildReadOnlyMemoryBlock('scout', 'project', tmpDir);
    expect(result).toContain('read-only');
  });

  it('does not include write instructions', () => {
    const result = buildReadOnlyMemoryBlock('scout', 'project', tmpDir);
    expect(result).not.toContain('Memory Instructions');
    expect(result).not.toContain('Create one at');
  });

  it('includes existing MEMORY.md contents', () => {
    const dir = path.join(tmpDir, '.flow', 'agent-memory', 'scout');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'MEMORY.md'), '# Scout notes\n\n- project uses monorepo');

    const result = buildReadOnlyMemoryBlock('scout', 'project', tmpDir);
    expect(result).toContain('project uses monorepo');
  });

  it('does not create the memory directory', () => {
    buildReadOnlyMemoryBlock('probe', 'project', tmpDir);
    const dir = path.join(tmpDir, '.flow', 'agent-memory', 'probe');
    expect(fs.existsSync(dir)).toBe(false);
  });

  it('shows no-memory message when MEMORY.md does not exist', () => {
    const result = buildReadOnlyMemoryBlock('probe', 'project', tmpDir);
    expect(result).toContain('No memory is available yet');
  });
});
