import { describe, it, expect, vi } from 'vitest';
import { detectEnv, buildEnvBlock, SUB_AGENT_CONTEXT } from './env.js';

describe('detectEnv', () => {
  it('detects git repo in a git directory', async () => {
    const env = await detectEnv(process.cwd());
    expect(env.isGitRepo).toBe(true);
    expect(env.branch).toBeTruthy();
    expect(env.platform).toBe(process.platform);
  });

  it('detects non-git directory', async () => {
    const env = await detectEnv('/tmp');
    expect(env.isGitRepo).toBe(false);
    expect(env.branch).toBe('');
  });

  it('uses async exec when provided', async () => {
    const exec = vi
      .fn()
      .mockResolvedValueOnce({ code: 0, stdout: 'true\n' })
      .mockResolvedValueOnce({ code: 0, stdout: 'main\n' });
    const env = await detectEnv('/my/project', exec);
    expect(env.isGitRepo).toBe(true);
    expect(env.branch).toBe('main');
    expect(exec).toHaveBeenCalledTimes(2);
  });
});

describe('buildEnvBlock', () => {
  it('includes git info when in a git repo', () => {
    const block = buildEnvBlock('/my/project', {
      isGitRepo: true,
      branch: 'main',
      platform: 'darwin',
    });
    expect(block).toContain('Working directory: /my/project');
    expect(block).toContain('Git repository: yes');
    expect(block).toContain('Branch: main');
    expect(block).toContain('Platform: darwin');
  });

  it('shows "Not a git repository" when not in git', () => {
    const block = buildEnvBlock('/tmp', {
      isGitRepo: false,
      branch: '',
      platform: 'linux',
    });
    expect(block).toContain('Not a git repository');
    expect(block).not.toContain('Branch:');
  });
});

describe('SUB_AGENT_CONTEXT', () => {
  it('contains tool usage guidelines', () => {
    expect(SUB_AGENT_CONTEXT).toContain('read tool instead of cat');
    expect(SUB_AGENT_CONTEXT).toContain('edit tool instead of sed');
    expect(SUB_AGENT_CONTEXT).toContain('Use absolute file paths');
  });
});
