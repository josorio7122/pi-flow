/**
 * runner.ts — In-process agent execution via pi's createAgentSession SDK.
 *
 * Replaces the subprocess model (spawn.ts) with direct session creation.
 * Agents run in-memory with full access to session events, steering, and abort.
 */

import {
  createAgentSession,
  SessionManager,
  SettingsManager,
  DefaultResourceLoader,
  readTool,
  bashTool,
  editTool,
  writeTool,
  grepTool,
  findTool,
  lsTool,
} from '@mariozechner/pi-coding-agent';
import type { ExtensionContext } from '@mariozechner/pi-coding-agent';
import type { FlowAgentConfig, SingleAgentResult, UsageStats } from './types.js';
import { injectVariables } from './agents.js';
import { buildMemoryBlock, buildReadOnlyMemoryBlock } from './memory.js';
import { emptyUsage } from './result-utils.js';
import { createWorktree, cleanupWorktree, type WorktreeInfo } from './worktree.js';
import { detectEnv, buildEnvBlock, SUB_AGENT_CONTEXT } from './env.js';

// ─── Constants ────────────────────────────────────────────────────────────────

/** Additional turns allowed after the soft steer message before hard abort. */
let graceTurns = 5;

/** Default max turns. undefined = unlimited. */
let defaultMaxTurns: number | undefined;

export function getGraceTurns(): number {
  return graceTurns;
}
export function setGraceTurns(n: number): void {
  graceTurns = Math.max(1, n);
}
export function getDefaultMaxTurns(): number | undefined {
  return defaultMaxTurns;
}
export function setDefaultMaxTurns(n: number | undefined): void {
  defaultMaxTurns = normalizeMaxTurns(n);
}

/** Normalize max turns: 0/undefined → unlimited, otherwise minimum 1. */
export function normalizeMaxTurns(n: number | undefined): number | undefined {
  if (n == null || n === 0) return undefined;
  return Math.max(1, n);
}

/** @deprecated Use getGraceTurns() instead. */
export const GRACE_TURNS = 5;

// ─── Tool resolution ──────────────────────────────────────────────────────────

const TOOL_MAP: Record<string, { name: string }> = {
  read: readTool,
  bash: bashTool,
  edit: editTool,
  write: writeTool,
  grep: grepTool,
  find: findTool,
  ls: lsTool,
};

/**
 * Maps agent tool name strings to pi built-in tool objects.
 * Unknown names are silently filtered out.
 * Applies denylist filtering when provided.
 */
export function resolveTools(toolNames: string[], disallowedTools?: string[]): { name: string }[] {
  const denied = disallowedTools ? new Set(disallowedTools) : undefined;
  return toolNames
    .filter((name) => !denied?.has(name))
    .map((name) => TOOL_MAP[name])
    .filter((t): t is { name: string } => t != null);
}

// ─── Model resolution ─────────────────────────────────────────────────────────

/**
 * Resolves a model string (e.g. "anthropic/claude-sonnet-4-6") against the
 * model registry. Falls back to the parent model if not found.
 */
export function resolveModel(
  modelRegistry: { find(provider: string, modelId: string): unknown },
  modelString: string,
  fallbackModel: unknown,
): unknown {
  if (!modelString) return fallbackModel;

  const slashIdx = modelString.indexOf('/');
  if (slashIdx !== -1) {
    const provider = modelString.slice(0, slashIdx);
    const modelId = modelString.slice(slashIdx + 1);
    const found = modelRegistry.find(provider, modelId);
    if (found) return found;
  }

  return fallbackModel;
}

// ─── Types ────────────────────────────────────────────────────────────────────

export interface RunAgentCallbacks {
  onToolActivity?: (activity: { type: 'start' | 'end'; toolName: string }) => void;
  onTextDelta?: (delta: string, fullText: string) => void;
  onTurnEnd?: (turnCount: number) => void;
  onUsageUpdate?: (usage: UsageStats) => void;
  /** Called when the agent session is created (before first prompt). */
  onSessionCreated?: (session: unknown) => void;
}

export interface RunAgentOptions {
  ctx: ExtensionContext;
  agent: FlowAgentConfig;
  task: string;
  variableMap: Record<string, string>;
  signal?: AbortSignal;
  callbacks?: RunAgentCallbacks;
  /** Feature name — used for worktree branch naming */
  feature?: string;
}

// ─── runAgent ─────────────────────────────────────────────────────────────────

/**
 * Runs an agent in-process via createAgentSession.
 *
 * - Injects variables into the agent's system prompt
 * - Creates an in-memory session with the correct model, tools, and thinking level
 * - Subscribes to session events for turn tracking, tool activity, and text streaming
 * - Enforces graceful turn limits (steer → grace → abort)
 * - Forwards abort signals to session.abort()
 * - Collects usage stats from session.getSessionStats()
 */
export async function runAgent(options: RunAgentOptions): Promise<SingleAgentResult> {
  const { ctx, agent, task, variableMap, signal, callbacks, feature } = options;
  const startedAt = Date.now();

  // 0. Worktree isolation for writable agents
  let effectiveCwd = ctx.cwd;
  let worktreeInfo: WorktreeInfo | undefined;
  let worktreeWarning = '';
  if (agent.isolation === 'worktree') {
    const agentId = `${agent.name}-${Date.now()}`;
    worktreeInfo = createWorktree(ctx.cwd, agentId, feature);
    if (worktreeInfo) {
      effectiveCwd = worktreeInfo.path;
    } else {
      worktreeWarning =
        '\n\n[WARNING: Worktree isolation was requested but failed (not a git repo, or no commits yet). Running in the main working directory instead.]';
    }
  }

  // 1. Build system prompt with variable injection + env block + memory block
  const env = detectEnv(effectiveCwd);
  const envBlock = buildEnvBlock(effectiveCwd, env);
  let systemPrompt: string;

  if (agent.promptMode === 'append') {
    // Append mode: env + parent prompt + sub-agent context + agent instructions
    const parentPrompt = ''; // TODO: add parent context forking in Phase 6
    systemPrompt =
      envBlock +
      (parentPrompt
        ? '\n\n<inherited_system_prompt>\n' + parentPrompt + '\n</inherited_system_prompt>'
        : '') +
      '\n\n' +
      SUB_AGENT_CONTEXT +
      '\n\n<agent_instructions>\n' +
      injectVariables(agent.systemPrompt, variableMap, agent.variables) +
      '\n</agent_instructions>';
  } else {
    // Replace mode (default): env + agent prompt
    systemPrompt =
      envBlock + '\n\n' + injectVariables(agent.systemPrompt, variableMap, agent.variables);
  }

  // 1b. Inject per-agent memory block if configured
  if (agent.memory) {
    // Detect write capability: check actual tool set + denylist (#114)
    const deniedSet = agent.disallowedTools ? new Set(agent.disallowedTools) : undefined;
    const effectiveTools = agent.tools.filter((t) => !deniedSet?.has(t));
    const hasWriteTools = effectiveTools.includes('write') || effectiveTools.includes('edit');
    const memoryBlock = hasWriteTools
      ? buildMemoryBlock(agent.name, agent.memory, effectiveCwd)
      : buildReadOnlyMemoryBlock(agent.name, agent.memory, effectiveCwd);
    systemPrompt = systemPrompt + '\n\n' + memoryBlock;
  }

  // 2. Create resource loader (no extensions, no skills — we inject via prompt)
  const loader = new DefaultResourceLoader({
    cwd: effectiveCwd,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    systemPromptOverride: () => systemPrompt,
  });
  await loader.reload();

  // 3. Resolve model
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Model<any> from pi SDK
  const model = resolveModel(ctx.modelRegistry, agent.model, ctx.model) as any;

  // 4. Resolve tools (with denylist)
  const tools = resolveTools(agent.tools, agent.disallowedTools);

  // 5. Create session
  const { session } = await createAgentSession({
    cwd: effectiveCwd,
    sessionManager: SessionManager.inMemory(effectiveCwd),
    settingsManager: SettingsManager.inMemory(),
    modelRegistry: ctx.modelRegistry,
    model,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- pi SDK Tool[] type is complex
    tools: tools as any,
    resourceLoader: loader,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- ThinkingLevel is a string union
    thinkingLevel: agent.thinking as any,
  });

  // 6. Enforce exact tool set (minus denylist)
  const denied = agent.disallowedTools ? new Set(agent.disallowedTools) : undefined;
  const activeTools = agent.tools.filter((t) => !denied?.has(t));
  session.setActiveToolsByName(activeTools);

  // 6b. Notify caller that session is ready (for pending steer flush, etc.)
  callbacks?.onSessionCreated?.(session);

  // 7. Turn tracking state
  let turnCount = 0;
  let softLimitReached = false;
  let aborted = false;
  const maxSteps = normalizeMaxTurns(agent.limits.max_steps) ?? defaultMaxTurns;

  // 8. Subscribe to session events
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- AgentSessionEvent union type
  const unsubscribe = session.subscribe((event: any) => {
    switch (event.type) {
      case 'turn_end':
        turnCount++;
        callbacks?.onTurnEnd?.(turnCount);

        // Graceful turn limits
        if (maxSteps != null) {
          if (!softLimitReached && turnCount >= maxSteps) {
            softLimitReached = true;
            session.steer(
              'You have reached your turn limit. Wrap up immediately — provide your final answer now.',
            );
          } else if (softLimitReached && turnCount >= maxSteps + graceTurns) {
            aborted = true;
            session.abort();
          }
        }
        break;

      case 'tool_execution_start':
        callbacks?.onToolActivity?.({ type: 'start', toolName: event.toolName });
        break;

      case 'tool_execution_end':
        callbacks?.onToolActivity?.({ type: 'end', toolName: event.toolName });
        break;

      case 'message_update':
        if (event.assistantMessageEvent?.type === 'text_delta') {
          const delta = event.assistantMessageEvent.delta;
          // Extract full text from the message
          const fullText = extractTextFromMessage(event.message);
          callbacks?.onTextDelta?.(delta, fullText);
        }
        break;
    }
  });

  // 9. Wire abort signal
  let removeAbortListener: (() => void) | undefined;
  if (signal) {
    const onAbort = () => session.abort();
    if (signal.aborted) {
      session.abort();
    } else {
      signal.addEventListener('abort', onAbort, { once: true });
      removeAbortListener = () => signal.removeEventListener('abort', onAbort);
    }
  }

  // 10. Execute
  try {
    const effectiveTask = worktreeWarning ? worktreeWarning + '\n\n' + task : task;
    await session.prompt(effectiveTask);

    // 11. Collect results
    const stats = session.getSessionStats();
    const stopReason = aborted ? 'aborted' : softLimitReached ? 'steered' : undefined;

    // 11b. Worktree cleanup
    let worktreeBranch: string | undefined;
    if (worktreeInfo) {
      const wtResult = cleanupWorktree(ctx.cwd, worktreeInfo, task);
      if (wtResult.hasChanges && wtResult.branch) {
        worktreeBranch = wtResult.branch;
      }
    }

    return {
      agent: agent.name,
      agentSource: agent.source,
      task,
      exitCode: aborted ? 1 : 0,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- AgentMessage[] → Record<string, unknown>[]
      messages: session.messages as any,
      stderr: '',
      usage: {
        input: stats.tokens.input,
        output: stats.tokens.output,
        cacheRead: stats.tokens.cacheRead,
        cacheWrite: stats.tokens.cacheWrite,
        cost: stats.cost,
        contextTokens: stats.tokens.total,
        turns: turnCount,
      },
      model: session.model ? `${session.model.provider}/${session.model.id}` : undefined,
      stopReason,
      startedAt,
      worktreeBranch,
    };
  } catch (err) {
    // Error during execution — clean up worktree
    if (worktreeInfo) {
      try {
        cleanupWorktree(ctx.cwd, worktreeInfo, task);
      } catch {
        /* worktree cleanup failure is non-fatal */
      }
    }
    const message = err instanceof Error ? err.message : String(err);
    return {
      agent: agent.name,
      agentSource: agent.source,
      task,
      exitCode: 1,
      messages: [],
      stderr: message,
      usage: emptyUsage(),
      model: session.model ? `${session.model.provider}/${session.model.id}` : undefined,
      stopReason: 'error',
      errorMessage: message,
      startedAt,
    };
  } finally {
    // 12. Cleanup
    unsubscribe();
    removeAbortListener?.();
    session.dispose();
  }
}

// ─── Internal helpers ─────────────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- AgentMessage content shape
function extractTextFromMessage(message: any): string {
  if (!message?.content) return '';
  for (const part of message.content) {
    if (part.type === 'text') return part.text ?? '';
  }
  return '';
}
