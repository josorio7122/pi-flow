import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { preloadSkills } from './skill-loader.js';

describe('preloadSkills', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flow-skills-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('loads a skill from project .pi/skills/', () => {
    const skillDir = path.join(tmpDir, '.pi', 'skills');
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(path.join(skillDir, 'test-skill.md'), 'Skill content here');

    const results = preloadSkills(['test-skill'], tmpDir);
    expect(results).toHaveLength(1);
    expect(results[0].name).toBe('test-skill');
    expect(results[0].content).toBe('Skill content here');
  });

  it('returns not-found note for missing skills', () => {
    const results = preloadSkills(['nonexistent'], tmpDir);
    expect(results).toHaveLength(1);
    expect(results[0].content).toContain('not found');
  });

  it('skips unsafe names', () => {
    const results = preloadSkills(['../etc/passwd'], tmpDir);
    expect(results[0].content).toContain('path traversal');
  });

  it('tries .md, .txt, and bare extensions', () => {
    const skillDir = path.join(tmpDir, '.pi', 'skills');
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(path.join(skillDir, 'plain.txt'), 'Text skill');

    const results = preloadSkills(['plain'], tmpDir);
    expect(results[0].content).toBe('Text skill');
  });
});
