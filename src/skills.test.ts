import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { parseSkillFrontmatter, discoverSkills } from './skills.js';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

describe('parseSkillFrontmatter', () => {
  it('parses valid skill frontmatter', () => {
    const content = `---
name: forcing-questions
description: Ask forcing questions before implementation.
trigger: before implementation
---

### Before starting

Ask 5 questions.
`;
    const skill = parseSkillFrontmatter(content, '/skills/forcing-questions.md');

    expect(skill).not.toBeNull();
    expect(skill!.name).toBe('forcing-questions');
    expect(skill!.description).toBe('Ask forcing questions before implementation.');
    expect(skill!.trigger).toBe('before implementation');
    expect(skill!.body).toContain('Ask 5 questions.');
    expect(skill!.source).toBe('builtin');
    expect(skill!.filePath).toBe('/skills/forcing-questions.md');
  });

  it('handles missing optional fields with defaults', () => {
    const content = `---
name: test-skill
description: A test skill.
---

Body here.
`;
    const skill = parseSkillFrontmatter(content, '/skills/test.md');

    expect(skill).not.toBeNull();
    expect(skill!.trigger).toBe('');
    expect(skill!.body).toContain('Body here.');
  });

  it('returns null for content without frontmatter', () => {
    const result = parseSkillFrontmatter('No frontmatter here.', '/x.md');
    expect(result).toBeNull();
  });

  it('returns null for content without name', () => {
    const content = `---
description: No name field.
---

Body.
`;
    const result = parseSkillFrontmatter(content, '/x.md');
    expect(result).toBeNull();
  });
});

describe('discoverSkills', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-flow-skills-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('discovers skills from a directory', () => {
    const skillsDir = path.join(tmpDir, 'skills');
    fs.mkdirSync(skillsDir, { recursive: true });
    fs.writeFileSync(
      path.join(skillsDir, 'my-skill.md'),
      `---
name: my-skill
description: A skill.
trigger: always
---

Do the thing.
`,
    );

    const skills = discoverSkills(tmpDir, '/nonexistent');
    expect(skills).toHaveLength(1);
    expect(skills[0].name).toBe('my-skill');
    expect(skills[0].source).toBe('builtin');
  });

  it('project skills override builtin skills with same name', () => {
    // Builtin
    const builtinDir = path.join(tmpDir, 'skills');
    fs.mkdirSync(builtinDir, { recursive: true });
    fs.writeFileSync(
      path.join(builtinDir, 'shared.md'),
      `---
name: shared
description: Builtin version.
---

Builtin body.
`,
    );

    // Project
    const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-flow-project-'));
    const projectSkillsDir = path.join(projectDir, '.flow', 'skills');
    fs.mkdirSync(projectSkillsDir, { recursive: true });
    fs.writeFileSync(
      path.join(projectSkillsDir, 'shared.md'),
      `---
name: shared
description: Project override.
---

Project body.
`,
    );

    const skills = discoverSkills(tmpDir, projectDir);
    const shared = skills.find((s) => s.name === 'shared');
    expect(shared).toBeDefined();
    expect(shared!.description).toBe('Project override.');
    expect(shared!.source).toBe('custom');

    fs.rmSync(projectDir, { recursive: true, force: true });
  });

  it('returns empty array when no skills directory exists', () => {
    const skills = discoverSkills('/nonexistent', '/also-nonexistent');
    expect(skills).toEqual([]);
  });

  it('skips non-.md files', () => {
    const skillsDir = path.join(tmpDir, 'skills');
    fs.mkdirSync(skillsDir, { recursive: true });
    fs.writeFileSync(path.join(skillsDir, 'readme.txt'), 'not a skill');
    fs.writeFileSync(
      path.join(skillsDir, 'real.md'),
      `---
name: real
description: Real skill.
---

Body.
`,
    );

    const skills = discoverSkills(tmpDir, '/nonexistent');
    expect(skills).toHaveLength(1);
    expect(skills[0].name).toBe('real');
  });
});
