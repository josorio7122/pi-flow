/**
 * env.ts — Detect environment info (git, platform) for agent system prompts.
 */

export interface EnvInfo {
  isGitRepo: boolean;
  branch: string;
  platform: string;
}

/** Async exec interface matching pi's ExtensionAPI.exec signature. */
export interface AsyncExec {
  (
    command: string,
    args: string[],
    options?: { cwd?: string; timeout?: number },
  ): Promise<{
    code: number;
    stdout: string;
  }>;
}

/**
 * Detect environment information for the given working directory.
 * Uses async exec when provided (pi.exec), falls back to child_process.
 */
export async function detectEnv(cwd: string, exec?: AsyncExec): Promise<EnvInfo> {
  let isGitRepo = false;
  let branch = '';

  if (exec) {
    try {
      const result = await exec('git', ['rev-parse', '--is-inside-work-tree'], {
        cwd,
        timeout: 5000,
      });
      isGitRepo = result.code === 0 && result.stdout.trim() === 'true';
    } catch {
      // Not a git repo
    }

    if (isGitRepo) {
      try {
        const result = await exec('git', ['branch', '--show-current'], { cwd, timeout: 5000 });
        branch = result.code === 0 ? result.stdout.trim() : 'unknown';
      } catch {
        branch = 'unknown';
      }
    }
  } else {
    // Fallback: synchronous (for tests / when pi.exec unavailable)
    const { execFileSync } = await import('node:child_process');
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
