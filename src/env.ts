/**
 * env.ts — Detect environment info (git, platform) for agent system prompts.
 */

import { execFileSync } from 'node:child_process';

export interface EnvInfo {
  isGitRepo: boolean;
  branch: string;
  platform: string;
}

/**
 * Detect environment information for the given working directory.
 * Uses synchronous git calls (fast, <5ms each).
 */
export function detectEnv(cwd: string): EnvInfo {
  let isGitRepo = false;
  let branch = '';

  try {
    const result = execFileSync('git', ['rev-parse', '--is-inside-work-tree'], {
      cwd,
      stdio: 'pipe',
      timeout: 5000,
    })
      .toString()
      .trim();
    isGitRepo = result === 'true';
  } catch {
    // Not a git repo
  }

  if (isGitRepo) {
    try {
      branch = execFileSync('git', ['branch', '--show-current'], {
        cwd,
        stdio: 'pipe',
        timeout: 5000,
      })
        .toString()
        .trim();
    } catch {
      branch = 'unknown';
    }
  }

  return { isGitRepo, branch, platform: process.platform };
}

/**
 * Build the environment block for agent system prompts.
 */
export function buildEnvBlock(cwd: string, env: EnvInfo): string {
  return `# Environment
Working directory: ${cwd}
${env.isGitRepo ? `Git repository: yes\nBranch: ${env.branch}` : 'Not a git repository'}
Platform: ${env.platform}`;
}

/**
 * Sub-agent context block — tool usage guidelines injected into agent prompts.
 */
export const SUB_AGENT_CONTEXT = `<sub_agent_context>
You are operating as a sub-agent invoked to handle a specific task.
- Use the read tool instead of cat/head/tail
- Use the edit tool instead of sed/awk
- Use the write tool instead of echo/heredoc
- Use the find tool instead of bash find/ls for file search
- Use the grep tool instead of bash grep/rg for content search
- Make independent tool calls in parallel
- Use absolute file paths
- Do not use emojis
- Be concise but complete
</sub_agent_context>`;
