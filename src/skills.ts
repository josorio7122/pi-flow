/**
 * Skill discovery and parsing.
 *
 * Skills are .md files with YAML frontmatter that get injected into
 * the coordinator prompt. The extension discovers them from:
 *   1. {extensionDir}/skills/*.md  — builtin skills
 *   2. {cwd}/.flow/skills/*.md     — project-specific overrides
 *
 * If a project skill has the same `name` as a builtin, the project version wins.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { FlowSkillConfig } from './types.js';

// ─── parseSkillFrontmatter ───────────────────────────────────────────────────

/**
 * Parses a skill .md file into a FlowSkillConfig.
 * Returns null if the file has no valid frontmatter or no name field.
 */
export function parseSkillFrontmatter(
  content: string,
  filePath: string,
): FlowSkillConfig | null {
  const match = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(content);
  if (!match) return null;

  const [, frontmatter, body] = match;
  const fields: Record<string, string> = {};

  for (const line of frontmatter.split('\n')) {
    const kvMatch = /^(\w[\w-]*):\s*(.+)$/.exec(line.trim());
    if (kvMatch) {
      fields[kvMatch[1]] = kvMatch[2].trim();
    }
  }

  const name = fields.name;
  if (!name) return null;

  return {
    name,
    description: fields.description ?? '',
    body: body.trim(),
    source: 'builtin',
    filePath,
  };
}

// ─── discoverSkills ──────────────────────────────────────────────────────────

/**
 * Discovers skill .md files from the extension's skills/ directory
 * and the project's .flow/skills/ directory. Project skills override
 * builtins with the same name.
 */
export function discoverSkills(extensionDir: string, cwd: string): FlowSkillConfig[] {
  const skillMap = new Map<string, FlowSkillConfig>();

  // 1. Builtin skills
  const builtinDir = path.join(extensionDir, 'skills');
  loadSkillsFromDir(builtinDir, 'builtin', skillMap);

  // 2. Project skills (override builtins)
  const projectDir = path.join(cwd, '.flow', 'skills');
  loadSkillsFromDir(projectDir, 'custom', skillMap);

  return Array.from(skillMap.values());
}

function loadSkillsFromDir(
  dir: string,
  source: 'builtin' | 'custom',
  map: Map<string, FlowSkillConfig>,
): void {
  let entries: string[];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return;
  }

  for (const entry of entries) {
    if (!entry.endsWith('.md')) continue;
    const filePath = path.join(dir, entry);
    try {
      const content = fs.readFileSync(filePath, 'utf8');
      const skill = parseSkillFrontmatter(content, filePath);
      if (skill) {
        skill.source = source;
        map.set(skill.name, skill);
      }
    } catch {
      // Skip unreadable files
    }
  }
}
