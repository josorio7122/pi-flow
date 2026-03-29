import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { execFileSync } from 'node:child_process';
import { createWorktree, cleanupWorktree, pruneWorktrees, type WorktreeInfo } from './worktree.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────

let repoDir: string;

function initGitRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'worktree-test-'));
  execFileSync('git', ['init'], { cwd: dir, stdio: 'pipe' });
  execFileSync('git', ['config', 'user.email', 'test@test.com'], { cwd: dir, stdio: 'pipe' });
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: dir, stdio: 'pipe' });
  fs.writeFileSync(path.join(dir, 'README.md'), '# Test');
  execFileSync('git', ['add', '.'], { cwd: dir, stdio: 'pipe' });
  execFileSync('git', ['commit', '-m', 'init'], { cwd: dir, stdio: 'pipe' });
  return dir;
}

function cleanupDir(dir: string) {
  try {
    // Remove any worktrees first
    execFileSync('git', ['worktree', 'prune'], { cwd: dir, stdio: 'pipe' });
  } catch {
    /* ignore */
  }
  fs.rmSync(dir, { recursive: true, force: true });
}

beforeEach(() => {
  repoDir = initGitRepo();
});

afterEach(() => {
  cleanupDir(repoDir);
});

// ─── createWorktree ───────────────────────────────────────────────────────────

describe('createWorktree', () => {
  it('creates a worktree directory', () => {
    const wt = createWorktree(repoDir, 'builder-123');
    expect(wt).toBeDefined();
    expect(fs.existsSync(wt!.path)).toBe(true);
    expect(fs.existsSync(path.join(wt!.path, 'README.md'))).toBe(true);

    // Cleanup
    execFileSync('git', ['worktree', 'remove', '--force', wt!.path], {
      cwd: repoDir,
      stdio: 'pipe',
    });
  });

  it('returns a branch name based on agent ID', () => {
    const wt = createWorktree(repoDir, 'builder-123');
    expect(wt).toBeDefined();
    expect(wt!.branch).toContain('builder-123');

    execFileSync('git', ['worktree', 'remove', '--force', wt!.path], {
      cwd: repoDir,
      stdio: 'pipe',
    });
  });

  it('includes feature name in branch when provided', () => {
    const wt = createWorktree(repoDir, 'builder-123', 'auth-refactor');
    expect(wt).toBeDefined();
    expect(wt!.branch).toContain('auth-refactor');
    expect(wt!.branch).toContain('builder-123');

    execFileSync('git', ['worktree', 'remove', '--force', wt!.path], {
      cwd: repoDir,
      stdio: 'pipe',
    });
  });

  it('returns undefined when not in a git repo', () => {
    const nonGitDir = fs.mkdtempSync(path.join(os.tmpdir(), 'no-git-'));
    const wt = createWorktree(nonGitDir, 'builder-123');
    expect(wt).toBeUndefined();
    fs.rmSync(nonGitDir, { recursive: true, force: true });
  });

  it('returns undefined when git repo has no commits', () => {
    const emptyRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'empty-repo-'));
    execFileSync('git', ['init'], { cwd: emptyRepo, stdio: 'pipe' });
    const wt = createWorktree(emptyRepo, 'builder-123');
    expect(wt).toBeUndefined();
    fs.rmSync(emptyRepo, { recursive: true, force: true });
  });
});

// ─── cleanupWorktree ──────────────────────────────────────────────────────────

describe('cleanupWorktree', () => {
  it('removes worktree when no changes', () => {
    const wt = createWorktree(repoDir, 'scout-456')!;
    expect(fs.existsSync(wt.path)).toBe(true);

    const result = cleanupWorktree(repoDir, wt, 'scout scan');
    expect(result.hasChanges).toBe(false);
    expect(result.branch).toBeUndefined();
  });

  it('commits changes and creates branch when worktree has modifications', () => {
    const wt = createWorktree(repoDir, 'builder-789')!;

    // Make a change in the worktree
    fs.writeFileSync(path.join(wt.path, 'new-file.ts'), 'export const x = 1;');

    const result = cleanupWorktree(repoDir, wt, 'implement auth');
    expect(result.hasChanges).toBe(true);
    expect(result.branch).toBeDefined();
    expect(result.branch).toContain('builder-789');

    // Verify the branch exists in the main repo
    const branches = execFileSync('git', ['branch', '--list', result.branch!], {
      cwd: repoDir,
      encoding: 'utf-8',
    }).trim();
    expect(branches).toContain(result.branch!);
  });

  it('handles non-existent worktree path gracefully', () => {
    const wt: WorktreeInfo = { path: '/tmp/nonexistent-worktree', branch: 'flow/test/builder' };
    const result = cleanupWorktree(repoDir, wt, 'test');
    expect(result.hasChanges).toBe(false);
  });

  it('commit message includes agent description', () => {
    const wt = createWorktree(repoDir, 'builder-commit')!;
    fs.writeFileSync(path.join(wt.path, 'file.ts'), 'code');

    const result = cleanupWorktree(repoDir, wt, 'implement login flow');
    expect(result.hasChanges).toBe(true);

    // Check the commit message on the branch
    const log = execFileSync('git', ['log', '--oneline', '-1', result.branch!], {
      cwd: repoDir,
      encoding: 'utf-8',
    }).trim();
    expect(log).toContain('implement login flow');
  });
});

// ─── pruneWorktrees ───────────────────────────────────────────────────────────

describe('pruneWorktrees', () => {
  it('does not throw on a clean repo', () => {
    expect(() => pruneWorktrees(repoDir)).not.toThrow();
  });

  it('does not throw on a non-git directory', () => {
    const nonGitDir = fs.mkdtempSync(path.join(os.tmpdir(), 'no-git-prune-'));
    expect(() => pruneWorktrees(nonGitDir)).not.toThrow();
    fs.rmSync(nonGitDir, { recursive: true, force: true });
  });

  it('cleans up orphaned worktree references', () => {
    const wt = createWorktree(repoDir, 'orphan-test')!;
    // Manually delete the worktree directory (simulating a crash)
    fs.rmSync(wt.path, { recursive: true, force: true });

    // Before prune, git worktree list shows the missing worktree
    pruneWorktrees(repoDir);

    // After prune, listing should only show the main worktree
    const list = execFileSync('git', ['worktree', 'list'], {
      cwd: repoDir,
      encoding: 'utf-8',
    }).trim();
    const lines = list.split('\n');
    expect(lines).toHaveLength(1); // Only the main worktree
  });
});
