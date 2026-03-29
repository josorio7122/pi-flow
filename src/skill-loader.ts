/**
 * skill-loader.ts — Preload specific skill files for injection into agent prompts.
 *
 * When an agent's `skills` config is a string[], reads each named skill
 * from .pi/skills/ or ~/.pi/skills/ and returns their content.
 */

import { homedir } from 'node:os';
import { join } from 'node:path';
import { safeReadFile, isUnsafeName } from './memory.js';

export interface PreloadedSkill {
  name: string;
  content: string;
}

/**
 * Load named skills from project and global skill directories.
 * Missing skills are included with a "not found" note.
 */
export function preloadSkills(skillNames: string[], cwd: string): PreloadedSkill[] {
  const results: PreloadedSkill[] = [];

  for (const name of skillNames) {
    if (isUnsafeName(name)) {
      results.push({
        name,
        content: `(Skill "${name}" skipped: name contains path traversal characters)`,
      });
      continue;
    }
    const content = findAndReadSkill(name, cwd);
    if (content !== undefined) {
      results.push({ name, content });
    } else {
      results.push({
        name,
        content: `(Skill "${name}" not found in .pi/skills/ or ~/.pi/skills/)`,
      });
    }
  }

  return results;
}

function findAndReadSkill(name: string, cwd: string): string | undefined {
  const projectDir = join(cwd, '.pi', 'skills');
  const globalDir = join(homedir(), '.pi', 'skills');

  for (const dir of [projectDir, globalDir]) {
    for (const ext of ['.md', '.txt', '']) {
      const content = safeReadFile(join(dir, name + ext));
      if (content !== undefined) return content.trim();
    }
  }

  return undefined;
}
