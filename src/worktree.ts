/**
 * worktree.ts — Git worktree isolation for agents.
 *
 * Creates temporary git worktrees so writable agents work on isolated copies.
 * On completion: no changes → cleanup; changes → commit, create branch, cleanup.
 *
 * Adopted from tintinweb/pi-subagents, enhanced with feature-scoped branch naming.
 */

import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface WorktreeInfo {
  /** Absolute path to the worktree directory. */
  path: string;
  /** Branch name created for this worktree (if changes exist). */
  branch: string;
}

export interface WorktreeCleanupResult {
  /** Whether changes were found in the worktree. */
  hasChanges: boolean;
  /** Branch name if changes were committed. */
  branch?: string;
}

// ─── Create ───────────────────────────────────────────────────────────────────

/**
 * Create a temporary git worktree for an agent.
 * Returns the worktree path, or undefined if not in a git repo or no commits.
 *
 * Branch naming: flow/{feature}/{agentId} or flow/ad-hoc/{agentId}
 */
export function createWorktree(
  cwd: string,
  agentId: string,
  feature?: string,
): WorktreeInfo | undefined {
  // Verify git repo with at least one commit
  try {
    execFileSync('git', ['rev-parse', '--is-inside-work-tree'], {
      cwd,
      stdio: 'pipe',
      timeout: 5000,
    });
    execFileSync('git', ['rev-parse', 'HEAD'], { cwd, stdio: 'pipe', timeout: 5000 });
  } catch {
    return undefined;
  }

  const featureSlug = feature ?? 'ad-hoc';
  const branch = `flow/${featureSlug}/${agentId}`;
  const suffix = randomUUID().slice(0, 8);
  const worktreePath = join(tmpdir(), `pi-flow-${agentId}-${suffix}`);

  try {
    execFileSync('git', ['worktree', 'add', '--detach', worktreePath, 'HEAD'], {
      cwd,
      stdio: 'pipe',
      timeout: 30000,
    });
    return { path: worktreePath, branch };
  } catch {
    return undefined;
  }
}

// ─── Cleanup ──────────────────────────────────────────────────────────────────

/**
 * Clean up a worktree after agent completion.
 * - No changes: remove worktree entirely.
 * - Changes exist: stage, commit, create branch, remove worktree.
 */
export function cleanupWorktree(
  cwd: string,
  worktree: WorktreeInfo,
  agentDescription: string,
): WorktreeCleanupResult {
  if (!existsSync(worktree.path)) {
    return { hasChanges: false };
  }

  try {
    const status = execFileSync('git', ['status', '--porcelain'], {
      cwd: worktree.path,
      stdio: 'pipe',
      timeout: 10000,
    })
      .toString()
      .trim();

    if (!status) {
      removeWorktree(cwd, worktree.path);
      return { hasChanges: false };
    }

    // Stage and commit changes
    execFileSync('git', ['add', '-A'], { cwd: worktree.path, stdio: 'pipe', timeout: 10000 });
    const safeDesc = agentDescription.slice(0, 200);
    execFileSync('git', ['commit', '-m', `pi-flow: ${safeDesc}`], {
      cwd: worktree.path,
      stdio: 'pipe',
      timeout: 10000,
    });

    // Create branch — append timestamp on collision
    let branchName = worktree.branch;
    try {
      execFileSync('git', ['branch', branchName], {
        cwd: worktree.path,
        stdio: 'pipe',
        timeout: 5000,
      });
    } catch {
      branchName = `${worktree.branch}-${Date.now()}`;
      execFileSync('git', ['branch', branchName], {
        cwd: worktree.path,
        stdio: 'pipe',
        timeout: 5000,
      });
    }

    removeWorktree(cwd, worktree.path);
    return { hasChanges: true, branch: branchName };
  } catch {
    try {
      removeWorktree(cwd, worktree.path);
    } catch {
      /* ignore */
    }
    return { hasChanges: false };
  }
}

// ─── Prune ────────────────────────────────────────────────────────────────────

/**
 * Prune orphaned worktrees (crash recovery).
 * Safe to call on non-git directories.
 */
export function pruneWorktrees(cwd: string): void {
  try {
    execFileSync('git', ['worktree', 'prune'], { cwd, stdio: 'pipe', timeout: 5000 });
  } catch {
    /* ignore — not a git repo or other error */
  }
}

// ─── Internal ─────────────────────────────────────────────────────────────────

function removeWorktree(cwd: string, worktreePath: string): void {
  try {
    execFileSync('git', ['worktree', 'remove', '--force', worktreePath], {
      cwd,
      stdio: 'pipe',
      timeout: 10000,
    });
  } catch {
    try {
      execFileSync('git', ['worktree', 'prune'], { cwd, stdio: 'pipe', timeout: 5000 });
    } catch {
      /* ignore */
    }
  }
}
