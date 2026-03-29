/**
 * pi-flow v2 — Extension entry point.
 *
 * Simplified: no state machine, no gates, no nudges.
 * The coordinator decides the workflow. The extension provides tools,
 * enforces tool blocking, tracks budget, and writes artifacts.
 */

import { fileURLToPath } from 'node:url';
import * as path from 'node:path';
import { Type } from '@sinclair/typebox';
import { Text } from '@mariozechner/pi-tui';
import type {
  ExtensionAPI,
  ExtensionContext,
  BeforeAgentStartEvent,
  SessionStartEvent,
  ToolCallEvent,
  ToolCallEventResult,
  ToolRenderResultOptions,
  AgentToolUpdateCallback,
} from '@mariozechner/pi-coding-agent';
import type { Theme, ThemeColor } from '@mariozechner/pi-coding-agent';

import { executeDispatch } from './dispatch.js';
import {
  readStateFile,
  generateSessionId,
  ensureSessionDir,
  readSessionFile,
  writeSessionFile,
} from './state.js';
import { discoverAgents } from './agents.js';
import { discoverSkills } from './skills.js';
import { buildCoordinatorPrompt } from './prompt.js';
import {
  renderSingleCall,
  renderParallelCall,
  renderChainCall,
  buildFlowResult,
} from './rendering.js';
import { hashToolCall, detectLoop } from './guardrails.js';
import { shouldBlockToolCall } from './tool-blocking.js';
import type { FlowDispatchDetails, FlowState, SessionState } from './types.js';
import { BackgroundManager, GroupJoinManager } from './background.js';
import { getFinalOutput } from './result-utils.js';
import { pruneWorktrees } from './worktree.js';

// ─── Module-level state ───────────────────────────────────────────────────────

const loopHistory: Array<{ tool: string; argsHash: string }> = [];
const LOOP_WINDOW = 10;
const LOOP_THRESHOLD = 3;

// Session isolation: each pi process gets a unique session ID.
// Feature is null until explicitly set by the first dispatch with a feature param.
let sessionId: string | null = null;
let sessionDir: string | null = null;
let sessionFeature: string | null = null;
let backgroundManager: BackgroundManager | null = null;
let groupJoinManager: GroupJoinManager | null = null;

// ─── Session initialization ──────────────────────────────────────────────────

function initSession(cwd: string): void {
  if (sessionId) return; // already initialized
  sessionId = generateSessionId();
  sessionDir = ensureSessionDir(cwd, sessionId);
  const state: SessionState = {
    session_id: sessionId,
    started_at: new Date().toISOString(),
    last_updated: new Date().toISOString(),
    feature: null,
    budget: { total_tokens: 0, total_cost_usd: 0 },
  };
  writeSessionFile(sessionDir, state);
}

// ─── Status helpers ──────────────────────────────────────────────────────────

function formatSessionStatus(): string {
  const lines = [`Session: ${sessionId ?? '(none)'}`];
  if (sessionFeature) {
    lines.push(`Feature: ${sessionFeature}`);
  } else {
    lines.push('Feature: (none — ad-hoc mode)');
  }
  return lines.join('\n');
}

function updateFooterStatus(ui: ExtensionContext['ui']): void {
  const label = sessionFeature ?? 'ad-hoc';
  ui.setStatus('pi-flow', `● ${label}`);
}

// ─── Extension entry point ────────────────────────────────────────────────────

export default function piFlow(pi: ExtensionAPI) {
  const extensionDir = path.dirname(fileURLToPath(import.meta.url));
  const rootDir = path.resolve(extensionDir, '..');

  // ─── 1. Tool: dispatch_flow ─────────────────────────────────────────────────

  pi.registerTool({
    name: 'dispatch_flow',
    label: 'Dispatch Flow Agent',
    description:
      'Dispatch specialized agents. Modes: single (agent+task), ' +
      'parallel (concurrent scouts), chain (sequential with {previous}).',
    promptSnippet:
      'Dispatch specialized subagents: scout (read-only code analysis), ' +
      'probe (runtime investigation), planner (task breakdown), ' +
      'test-writer (writes failing tests — RED), ' +
      'builder (writes implementation — GREEN), ' +
      'doc-writer (documentation), reviewer (spec compliance + security). ' +
      'Feature must be explicitly set on first dispatch.',
    parameters: Type.Object({
      agent: Type.Optional(
        Type.String({
          description: 'Agent name (scout/probe/planner/test-writer/builder/doc-writer/reviewer)',
        }),
      ),
      task: Type.Optional(Type.String({ description: 'Task description' })),
      parallel: Type.Optional(
        Type.Array(
          Type.Object({
            agent: Type.String({ description: 'Agent name' }),
            task: Type.String({ description: 'Task for this agent' }),
          }),
          { description: 'Parallel dispatch — all agents start simultaneously', maxItems: 8 },
        ),
      ),
      chain: Type.Optional(
        Type.Array(
          Type.Object({
            agent: Type.String({ description: 'Agent name' }),
            task: Type.String({
              description: "Task. Use {previous} to reference prior agent's output.",
            }),
          }),
          { description: 'Chain dispatch — sequential with {previous} substitution' },
        ),
      ),
      feature: Type.Optional(
        Type.String({
          description: 'Feature name (kebab-case). Only needed for first dispatch.',
          pattern: '^[a-z0-9][a-z0-9-]*$',
          minLength: 1,
          maxLength: 64,
        }),
      ),
      background: Type.Optional(
        Type.Boolean({
          description:
            'Run agents in background. Returns agent IDs immediately. ' +
            'You will be notified on completion. Use get_agent_result to retrieve results.',
        }),
      ),
    }),

    async execute(
      _: string,
      params: {
        agent?: string;
        task?: string;
        parallel?: Array<{ agent: string; task: string }>;
        chain?: Array<{ agent: string; task: string }>;
        feature?: string;
        background?: boolean;
      },
      signal: AbortSignal | undefined,
      onUpdate: AgentToolUpdateCallback<FlowDispatchDetails> | undefined,
      ctx: ExtensionContext,
    ) {
      // Initialize session on first dispatch
      initSession(ctx.cwd);

      // Bind feature to session when explicitly provided
      if (params.feature) {
        sessionFeature = params.feature;
        // Update session file with feature binding
        if (sessionDir) {
          const existing = readSessionFile(sessionDir);
          if (existing) {
            writeSessionFile(sessionDir, {
              ...existing,
              feature: sessionFeature,
              last_updated: new Date().toISOString(),
            });
          }
        }
      }

      // Use session-bound feature if no explicit feature in this call
      const feature = params.feature ?? sessionFeature ?? undefined;

      const result = await executeDispatch(
        { ...params, feature, sessionDir: sessionDir ?? undefined, background: params.background },
        ctx.cwd,
        rootDir,
        ctx,
        signal,
        onUpdate
          ? (partial: {
              content: Array<{ type: 'text'; text: string }>;
              details: FlowDispatchDetails;
            }) => {
              onUpdate({ content: partial.content, details: partial.details });
            }
          : undefined,
        backgroundManager ?? undefined,
        groupJoinManager ?? undefined,
      );

      // Update footer status
      if (ctx.hasUI) {
        updateFooterStatus(ctx.ui);
      }

      return result;
    },

    renderCall(
      args: {
        agent?: string;
        task?: string;
        parallel?: Array<{ agent: string; task: string }>;
        chain?: Array<{ agent: string; task: string }>;
      },
      theme: Theme,
      context: { executionStarted: boolean },
    ) {
      const colorize = (color: string, t: string): string => theme.fg(color as ThemeColor, t);
      const bold = (t: string): string => theme.bold(t);

      // Once execution starts, show minimal header — agent cards in renderResult
      // already display each task with live progress, so repeating them here is redundant.
      const minimal = context.executionStarted;

      let text: string;
      if (args.parallel && args.parallel.length > 0) {
        text = renderParallelCall(args.parallel, 'builtin', colorize, bold, minimal);
      } else if (args.chain && args.chain.length > 0) {
        text = renderChainCall(args.chain, 'builtin', colorize, bold, minimal);
      } else {
        text = renderSingleCall(
          args.agent ?? '...',
          args.task ?? '...',
          'builtin',
          colorize,
          bold,
          minimal,
        );
      }

      return new Text(text, 0, 0);
    },

    renderResult(
      result: {
        content: Array<{ type: string; text?: string }>;
        details: FlowDispatchDetails | undefined;
      },
      options: ToolRenderResultOptions,
      theme: Theme,
    ) {
      const details = result.details;
      if (!details || details.results.length === 0) {
        const first = result.content[0];
        return new Text(first?.type === 'text' ? first.text : '(no output)', 0, 0);
      }
      return buildFlowResult(details, options, theme);
    },
  });

  // ─── 2. Background agent tools ──────────────────────────────────────────────

  // Initialize group join manager for batching parallel notifications
  function sendCompletionNotification(
    agentName: string,
    id: string,
    task: string,
    status: string,
    error?: string,
    messages?: Record<string, unknown>[],
  ) {
    const preview = messages ? getFinalOutput(messages).slice(0, 500) : '';
    pi.sendMessage(
      {
        customType: 'flow-agent-complete',
        content:
          `Background agent completed: ${agentName}\n` +
          `Task: ${task}\n` +
          `Status: ${status}\n` +
          (error ? `Error: ${error}\n` : '') +
          (preview ? `\nResult preview:\n${preview}\n` : '') +
          `\nUse get_agent_result({ agent_id: "${id}" }) for full results.`,
        display: true,
      },
      { deliverAs: 'followUp', triggerTurn: true },
    );
  }

  groupJoinManager = new GroupJoinManager((results, partial) => {
    const label = partial
      ? `${results.length} agent(s) finished (partial — others still running)`
      : `${results.length} agent(s) finished`;
    const summaries = results
      .map((r) => `- ${r.agent}: ${r.exitCode === 0 ? 'completed' : 'error'}`)
      .join('\n');
    pi.sendMessage(
      {
        customType: 'flow-agent-group-complete',
        content: `Background agent group: ${label}\n\n${summaries}\n\nUse get_agent_result for full results.`,
        display: true,
      },
      { deliverAs: 'followUp', triggerTurn: true },
    );
  }, 30_000);

  // Initialize background manager with completion notifications
  const gjm = groupJoinManager;
  backgroundManager = new BackgroundManager({
    onComplete: (record) => {
      // Route through group join or send individual notification
      if (record.result) {
        const joinResult = gjm.onAgentComplete(record.id, record.result);
        if (joinResult === 'pass') {
          sendCompletionNotification(
            record.agent.name,
            record.id,
            record.task,
            record.status,
            record.error,
            record.result.messages,
          );
        }
        // 'held' → group will fire later; 'delivered' → group callback already fired
      } else {
        // Error case — no result, send individual notification
        sendCompletionNotification(
          record.agent.name,
          record.id,
          record.task,
          record.status,
          record.error,
        );
      }
    },
  });

  pi.registerTool({
    name: 'get_agent_result',
    label: 'Get Agent Result',
    description:
      'Check status and retrieve results from a background agent. ' +
      'Use the agent ID returned by dispatch_flow with background: true.',
    parameters: Type.Object({
      agent_id: Type.String({ description: 'The agent ID to check.' }),
      wait: Type.Optional(
        Type.Boolean({
          description: 'If true, wait for the agent to complete. Default: false.',
        }),
      ),
    }),
    async execute(
      _: string,
      params: { agent_id: string; wait?: boolean },
      _signal: AbortSignal | undefined,
      _onUpdate: unknown,
      _ctx: ExtensionContext,
    ) {
      if (!backgroundManager) {
        return {
          content: [{ type: 'text' as const, text: 'Error: Background manager not initialized.' }],
          isError: true,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any -- AgentToolResult requires details
          details: undefined as any,
        };
      }

      const record = backgroundManager.getRecord(params.agent_id);
      if (!record) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `Agent not found: "${params.agent_id}". It may have been cleaned up.`,
            },
          ],
          isError: true,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any -- AgentToolResult requires details
          details: undefined as any,
        };
      }

      if (
        params.wait &&
        record.promise &&
        (record.status === 'running' || record.status === 'queued')
      ) {
        await record.promise.catch(() => {});
      }

      const output =
        `Agent: ${record.id}\n` +
        `Type: ${record.agent.name} | Status: ${record.status}\n` +
        `Description: ${record.description}\n\n` +
        (record.status === 'running' || record.status === 'queued'
          ? 'Agent is still running. Use wait: true or check back later.'
          : record.status === 'error'
            ? `Error: ${record.error}`
            : record.result
              ? getFinalOutput(record.result.messages) || 'No output.'
              : 'No output.');

      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- AgentToolResult requires details
      return { content: [{ type: 'text' as const, text: output }], details: undefined as any };
    },
  });

  pi.registerTool({
    name: 'steer_agent',
    label: 'Steer Agent',
    description:
      'Send a steering message to a running background agent. ' +
      'The message will be injected into the agent conversation after its current tool execution.',
    parameters: Type.Object({
      agent_id: Type.String({ description: 'The agent ID to steer (must be running).' }),
      message: Type.String({ description: 'The steering message to send.' }),
    }),
    async execute(
      _: string,
      params: { agent_id: string; message: string },
      _signal: AbortSignal | undefined,
      _onUpdate: unknown,
      _ctx: ExtensionContext,
    ) {
      if (!backgroundManager) {
        return {
          content: [{ type: 'text' as const, text: 'Error: Background manager not initialized.' }],
          isError: true,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any -- AgentToolResult requires details
          details: undefined as any,
        };
      }

      const record = backgroundManager.getRecord(params.agent_id);
      if (!record) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `Agent not found: "${params.agent_id}".`,
            },
          ],
          isError: true,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any -- AgentToolResult requires details
          details: undefined as any,
        };
      }

      if (record.status !== 'running') {
        return {
          content: [
            {
              type: 'text' as const,
              text: `Agent "${params.agent_id}" is not running (status: ${record.status}).`,
            },
          ],
          isError: true,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any -- AgentToolResult requires details
          details: undefined as any,
        };
      }

      backgroundManager.steer(params.agent_id, params.message);
      return {
        content: [
          {
            type: 'text' as const,
            text: `Steering message sent to agent ${record.id}. It will be processed after the current tool execution.`,
          },
        ],
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- AgentToolResult requires details
        details: undefined as any,
      };
    },
  });

  // ─── 3. Commands ────────────────────────────────────────────────────────────

  pi.registerCommand('flow', {
    description: 'Show pi-flow session status',
    handler: async () => {
      const summary = formatSessionStatus();
      pi.sendMessage({
        customType: 'pi-flow-status',
        content: `[Flow Status]\n\n${summary}`,
        display: true,
      });
    },
  });

  // ─── 3. Event hooks ─────────────────────────────────────────────────────────

  // before_agent_start — inject coordinator prompt
  pi.on('before_agent_start', async (event: BeforeAgentStartEvent, ctx: ExtensionContext) => {
    try {
      const agents = discoverAgents(rootDir, ctx.cwd);
      const skills = discoverSkills(rootDir, ctx.cwd);

      // Build active feature context for coordinator prompt
      let active: { state: FlowState; featureDir: string } | null = null;
      if (sessionFeature) {
        const featureDir = path.join(ctx.cwd, '.flow', 'features', sessionFeature);
        const state = readStateFile(featureDir);
        if (state) active = { state, featureDir };
      }

      const prompt = buildCoordinatorPrompt(agents, skills, active);
      return { systemPrompt: event.systemPrompt + '\n\n' + prompt };
    } catch {
      return {
        systemPrompt:
          event.systemPrompt +
          '\n\n## Coordinator\n\nYou have `dispatch_flow` available. Use /flow for status.',
      };
    }
  });

  // input — reset loop detection per turn
  pi.on('input', async () => {
    loopHistory.length = 0;
  });

  // session_start — prune orphaned worktrees, clear completed background agents
  pi.on('session_start', async (_: SessionStartEvent, ctx: ExtensionContext) => {
    pruneWorktrees(ctx.cwd);
    backgroundManager?.clearCompleted();
    if (!ctx.hasUI) return;
    updateFooterStatus(ctx.ui);
  });

  // session_shutdown — abort all background agents
  pi.on('session_shutdown' as 'session_start', async () => {
    groupJoinManager?.dispose();
    backgroundManager?.dispose();
  });

  // tool_call — enforce coordinator write restrictions + loop detection
  pi.on('tool_call', async (event: ToolCallEvent): Promise<ToolCallEventResult> => {
    const name = event.toolName;
    const input = event.input as Record<string, unknown>;

    // Tool blocking: coordinator can't write outside .flow/
    const blockResult = shouldBlockToolCall(name, input);
    if (blockResult.block) return blockResult;

    // Loop detection
    const hash = hashToolCall(name, input);
    loopHistory.push({ tool: name, argsHash: hash });
    if (loopHistory.length > LOOP_WINDOW) loopHistory.shift();

    const loop = detectLoop(loopHistory, LOOP_WINDOW, LOOP_THRESHOLD);
    if (loop.tripped) {
      return {
        block: true,
        reason: `Loop detected: '${loop.tool}' called ${loop.count} times with identical args. Try a different approach.`,
      };
    }

    return {};
  });
}
