/**
 * memory.ts — Persistent per-agent memory with project and global scopes.
 *
 * Adopted from tintinweb/pi-subagents' memory system, enhanced for pi-flow's
 * two-tier memory model (per-agent + cross-agent shared memory).
 *
 * Memory scopes:
 *   - "project" → .flow/agent-memory/{agent-name}/
 *   - "global"  → ~/.pi/flow-memory/{agent-name}/
 *
 * Each agent gets a MEMORY.md index file (200-line limit) and can store
 * additional files in their memory directory.
 */

import { existsSync, lstatSync, mkdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

// ─── Constants ────────────────────────────────────────────────────────────────

export type MemoryScope = 'project' | 'global' | 'local';

/** Maximum lines to read from MEMORY.md before truncation. */
export const MAX_MEMORY_LINES = 200;

// ─── Security helpers ─────────────────────────────────────────────────────────

/**
 * Returns true if a name contains characters not allowed in agent names.
 * Whitelist: alphanumeric, hyphens, underscores, dots (no leading dot).
 */
export function isUnsafeName(name: string): boolean {
  if (!name || name.length > 128) return true;
  return !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(name);
}

/**
 * Returns true if the given path is a symlink.
 * Defense against symlink-based directory traversal attacks.
 */
export function isSymlink(filePath: string): boolean {
  try {
    return lstatSync(filePath).isSymbolicLink();
  } catch {
    return false;
  }
}

/**
 * Safely read a file, rejecting symlinks.
 * Returns undefined if the file doesn't exist, is a symlink, or can't be read.
 */
export function safeReadFile(filePath: string): string | undefined {
  if (!existsSync(filePath)) return undefined;
  if (isSymlink(filePath)) return undefined;
  try {
    return readFileSync(filePath, 'utf-8');
  } catch {
    return undefined;
  }
}

// ─── Directory resolution ─────────────────────────────────────────────────────

/**
 * Resolve the memory directory path for a given agent + scope + cwd.
 * Throws if agentName contains path traversal characters.
 */
export function resolveMemoryDir(agentName: string, scope: MemoryScope, cwd: string): string {
  if (isUnsafeName(agentName)) {
    throw new Error(`Unsafe agent name for memory directory: "${agentName}"`);
  }
  switch (scope) {
    case 'project':
      return join(cwd, '.flow', 'agent-memory', agentName);
    case 'global':
      return join(homedir(), '.pi', 'flow-memory', agentName);
    case 'local':
      return join(cwd, '.flow', 'agent-memory-local', agentName);
  }
}

/**
 * Ensure the memory directory exists, creating it if needed.
 * Refuses to create directories if the target path is a symlink.
 */
export function ensureMemoryDir(memoryDir: string): void {
  if (existsSync(memoryDir)) {
    if (isSymlink(memoryDir)) {
      throw new Error(`Refusing to use symlinked memory directory: ${memoryDir}`);
    }
    return;
  }
  mkdirSync(memoryDir, { recursive: true });
}

// ─── Memory reading ───────────────────────────────────────────────────────────

/**
 * Read the first N lines of MEMORY.md from the memory directory.
 * Returns undefined if no MEMORY.md exists or if the directory is a symlink.
 */
export function readMemoryIndex(memoryDir: string): string | undefined {
  if (isSymlink(memoryDir)) return undefined;

  const memoryFile = join(memoryDir, 'MEMORY.md');
  const content = safeReadFile(memoryFile);
  if (content === undefined) return undefined;

  const lines = content.split('\n');
  if (lines.length > MAX_MEMORY_LINES) {
    return lines.slice(0, MAX_MEMORY_LINES).join('\n') + '\n... (truncated at 200 lines)';
  }
  return content;
}

// ─── Prompt building ──────────────────────────────────────────────────────────

/**
 * Build the memory block for writable agents.
 * Creates the memory directory and includes write instructions.
 */
export function buildMemoryBlock(agentName: string, scope: MemoryScope, cwd: string): string {
  const memoryDir = resolveMemoryDir(agentName, scope, cwd);
  ensureMemoryDir(memoryDir);

  const existingMemory = readMemoryIndex(memoryDir);

  const header = `# Agent Memory

You have a persistent memory directory at: ${memoryDir}/
Memory scope: ${scope}

This memory persists across sessions. Use it to build up knowledge over time.`;

  const memoryContent = existingMemory
    ? `\n\n## Current MEMORY.md\n${existingMemory}`
    : `\n\nNo MEMORY.md exists yet. Create one at ${join(memoryDir, 'MEMORY.md')} to start building persistent memory.`;

  const instructions = `

## Memory Instructions
- MEMORY.md is an index file — keep it concise (under 200 lines). Lines after 200 are truncated.
- Store detailed memories in separate files within ${memoryDir}/ and link to them from MEMORY.md.
- Each memory file should use this frontmatter format:
  \`\`\`markdown
  ---
  name: <memory name>
  description: <one-line description>
  type: <user|feedback|project|reference>
  ---
  <memory content>
  \`\`\`
- Update or remove memories that become outdated. Check for existing memories before creating duplicates.
- You have Read, Write, and Edit tools available for managing memory files.`;

  return header + memoryContent + instructions;
}

/**
 * Build a read-only memory block for agents that lack write/edit tools.
 * Does NOT create the memory directory — read-only agents only consume existing memory.
 */
export function buildReadOnlyMemoryBlock(
  agentName: string,
  scope: MemoryScope,
  cwd: string,
): string {
  const memoryDir = resolveMemoryDir(agentName, scope, cwd);
  const existingMemory = readMemoryIndex(memoryDir);

  const header = `# Agent Memory (read-only)

Memory scope: ${scope}
You have read-only access to memory. You can reference existing memories but cannot create or modify them.`;

  const memoryContent = existingMemory
    ? `\n\n## Current MEMORY.md\n${existingMemory}`
    : '\n\nNo memory is available yet. Other agents or sessions with write access can create memories for you to consume.';

  return header + memoryContent;
}
