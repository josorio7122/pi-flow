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
import { BackgroundManager, GroupJoinManager, type BackgroundRecord } from './background.js';
import { getFinalOutput } from './result-utils.js';
import { getAgentConversation } from './context.js';
import { pruneWorktrees } from './worktree.js';
import { registerRpcHandlers } from './cross-extension-rpc.js';
import { formatTaskNotification, buildNotificationDetails } from './notification.js';
import type { NotificationDetails } from './notification.js';
import { formatTokens, formatTurns } from './ui/agent-widget.js';

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
import type { AgentActivity } from './ui/agent-widget.js';
const agentActivity = new Map<string, AgentActivity>();

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

  // ─── 0. Custom notification renderer (gap 2) ───────────────────────────────

  pi.registerMessageRenderer<NotificationDetails>(
    'flow-notification',
    (message, { expanded }, theme) => {
      const d = message.details;
      if (!d) return undefined;

      function renderOne(det: NotificationDetails): string {
        const isError = det.status === 'error' || det.status === 'aborted';
        const icon = isError
          ? theme.fg('error' as ThemeColor, '✗')
          : theme.fg('success' as ThemeColor, '✓');
        const statusText = isError
          ? det.status
          : det.status === 'steered'
            ? 'completed (steered)'
            : 'completed';

        let line = `${icon} ${theme.bold(det.description)} ${theme.fg('dim' as ThemeColor, statusText)}`;

        const parts: string[] = [];
        if (det.turnCount > 0) parts.push(formatTurns(det.turnCount, det.maxTurns));
        if (det.toolUses > 0)
          parts.push(`${det.toolUses} tool use${det.toolUses === 1 ? '' : 's'}`);
        if (det.totalTokens > 0) parts.push(formatTokens(det.totalTokens));
        if (det.durationMs > 0) parts.push(`${(det.durationMs / 1000).toFixed(1)}s`);
        if (parts.length) {
          line +=
            '\n  ' +
            parts
              .map((p) => theme.fg('dim' as ThemeColor, p))
              .join(' ' + theme.fg('dim' as ThemeColor, '·') + ' ');
        }

        if (expanded) {
          const lines = det.resultPreview.split('\n').slice(0, 30);
          for (const l of lines) line += '\n' + theme.fg('dim' as ThemeColor, `  ${l}`);
        } else {
          const preview = det.resultPreview.split('\n')[0]?.slice(0, 80) ?? '';
          line += '\n  ' + theme.fg('dim' as ThemeColor, `⎿  ${preview}`);
        }

        if (det.outputFile) {
          line += '\n  ' + theme.fg('muted' as ThemeColor, `transcript: ${det.outputFile}`);
        }

        return line;
      }

      const all = [d, ...(d.others ?? [])];
      return new Text(all.map(renderOne).join('\n'), 0, 0);
    },
  );

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
      model: Type.Optional(
        Type.String({
          description:
            'Model override. Accepts "provider/modelId" or fuzzy name (e.g. "haiku", "sonnet").',
        }),
      ),
      thinking: Type.Optional(
        Type.String({
          description: 'Thinking level override: off, minimal, low, medium, high, xhigh.',
        }),
      ),
      max_turns: Type.Optional(
        Type.Number({
          description: 'Maximum agentic turns before stopping. Omit for agent default.',
          minimum: 1,
        }),
      ),
      isolated: Type.Optional(
        Type.Boolean({
          description: 'If true, agent gets no extension tools — only built-in tools.',
        }),
      ),
      isolation: Type.Optional(
        Type.Literal('worktree', {
          description:
            'Set to "worktree" to run in a temporary git worktree (isolated copy of repo).',
        }),
      ),
      inherit_context: Type.Optional(
        Type.Boolean({
          description: 'If true, fork parent conversation context into the agent.',
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
        model?: string;
        thinking?: string;
        max_turns?: number;
        isolated?: boolean;
        isolation?: 'worktree';
        inherit_context?: boolean;
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
        {
          ...params,
          feature,
          sessionDir: sessionDir ?? undefined,
          background: params.background,
          model: params.model,
          thinking: params.thinking,
          max_turns: params.max_turns,
          isolated: params.isolated,
          isolation: params.isolation,
          inherit_context: params.inherit_context,
          // Gap 10: Wire activity tracking for live widget
          activityCallbacks: {
            onAgentStart: (id) => {
              agentActivity.set(id, {
                activeTools: new Map(),
                toolUses: 0,
                tokens: '',
                responseText: '',
                turnCount: 1,
                maxTurns: params.max_turns,
              });
            },
            onToolActivity: (id, activity) => {
              const state = agentActivity.get(id);
              if (!state) return;
              if (activity.type === 'start') {
                state.activeTools.set(activity.toolName + '_' + Date.now(), activity.toolName);
              } else {
                for (const [key, name] of state.activeTools) {
                  if (name === activity.toolName) {
                    state.activeTools.delete(key);
                    break;
                  }
                }
                state.toolUses++;
              }
            },
            onTextDelta: (id, _, fullText) => {
              const state = agentActivity.get(id);
              if (state) state.responseText = fullText;
            },
            onTurnEnd: (id, turnCount) => {
              const state = agentActivity.get(id);
              if (state) state.turnCount = turnCount;
            },
          },
        },
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
  function sendCompletionNotification(record: BackgroundRecord) {
    const notification = formatTaskNotification(record, 500);
    const footer = record.outputFile ? `\nFull transcript available at: ${record.outputFile}` : '';
    const details = buildNotificationDetails(record, 500);
    const activity = agentActivity.get(record.id);
    if (activity) {
      // Enrich with live turn count if available
      details.toolUses = activity.toolUses;
    }

    pi.sendMessage<NotificationDetails>(
      {
        customType: 'flow-notification',
        content: notification + footer,
        display: true,
        details,
      },
      { deliverAs: 'followUp', triggerTurn: true },
    );
  }

  groupJoinManager = new GroupJoinManager((results, partial) => {
    // Clean up activity tracking for completed agents
    for (const r of results) {
      agentActivity.delete(`bg-${r.agent}`);
    }

    const unconsumedResults = results.filter((r) => {
      const rec = backgroundManager?.listAgents().find((a) => a.result === r);
      return !rec?.resultConsumed;
    });
    if (unconsumedResults.length === 0) return;

    const label = partial
      ? `${unconsumedResults.length} agent(s) finished (partial — others still running)`
      : `${unconsumedResults.length} agent(s) finished`;
    const notifications = unconsumedResults
      .map((r) => `- ${r.agent}: ${r.exitCode === 0 ? 'completed' : 'error'}`)
      .join('\n');

    // Build grouped notification details
    const records = unconsumedResults
      .map((r) => backgroundManager?.listAgents().find((a) => a.result === r))
      .filter(Boolean) as BackgroundRecord[];
    const [first, ...rest] = records;
    const details = first ? buildNotificationDetails(first, 300) : undefined;
    if (details && rest.length > 0) {
      details.others = rest.map((r) => buildNotificationDetails(r, 300));
    }

    pi.sendMessage<NotificationDetails>(
      {
        customType: 'flow-notification',
        content: `Background agent group completed: ${label}\n\n${notifications}\n\nUse get_agent_result for full output.`,
        display: true,
        details,
      },
      { deliverAs: 'followUp', triggerTurn: true },
    );
  }, 30_000);

  // Initialize background manager with completion notifications
  const gjm = groupJoinManager;
  backgroundManager = new BackgroundManager({
    onStart: (record) => {
      pi.events.emit('flow:started', {
        id: record.id,
        type: record.agent.name,
        description: record.description,
      });
    },
    onComplete: (record) => {
      // Emit lifecycle event
      const isError = record.status === 'error' || record.status === 'aborted';
      pi.events.emit(isError ? 'flow:failed' : 'flow:completed', {
        id: record.id,
        type: record.agent.name,
        description: record.description,
        status: record.status,
        error: record.error,
      });

      // Gap 1: Persist agent record for cross-session history
      pi.appendEntry('flow:record', {
        id: record.id,
        type: record.agent.name,
        description: record.description,
        status: record.status,
        error: record.error,
        startedAt: record.startedAt,
        completedAt: record.completedAt,
      });

      // Clean up activity tracking
      agentActivity.delete(record.id);

      // Skip notification if result was already consumed via get_agent_result
      if (record.resultConsumed) return;

      // Route through group join or send individual notification
      if (record.result) {
        const joinResult = gjm.onAgentComplete(record.id, record.result);
        if (joinResult === 'pass') {
          sendCompletionNotification(record);
        }
        // 'held' → group will fire later; 'delivered' → group callback already fired
      } else {
        // Error case — no result, send individual notification
        sendCompletionNotification(record);
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
      verbose: Type.Optional(
        Type.Boolean({
          description:
            'If true, include the full agent conversation (messages + tool calls). Default: false.',
        }),
      ),
    }),
    async execute(
      _: string,
      params: { agent_id: string; wait?: boolean; verbose?: boolean },
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
        // Pre-mark consumed before await to suppress completion notification
        record.resultConsumed = true;
        await record.promise.catch(() => {});
      }

      // Mark as consumed to suppress notification
      if (record.status !== 'running' && record.status !== 'queued') {
        record.resultConsumed = true;
      }

      let output =
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

      // Verbose: include full conversation
      if (params.verbose && record.result) {
        const conversation = getAgentConversation(
          record.result.messages as Array<{ role: string; content: unknown }>,
        );
        if (conversation) {
          output += `\n\n--- Agent Conversation ---\n${conversation}`;
        }
      }

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

  // ─── 2b. Cross-extension integration ─────────────────────────────────────────

  // Global manager registry for cross-package access
  const MANAGER_KEY = Symbol.for('pi-flow:manager');
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- global registry pattern
  (globalThis as any)[MANAGER_KEY] = {
    waitForAll: () => backgroundManager?.waitForAll(),
    hasRunning: () => backgroundManager?.hasRunning() ?? false,
    getRecord: (id: string) => backgroundManager?.getRecord(id),
  };

  // Register cross-extension RPC handlers
  const rpcHandle = registerRpcHandlers({
    events: pi.events,
    getManager: () => backgroundManager ?? undefined,
  });

  // Broadcast readiness
  pi.events.emit('flow:ready', {});

  // ─── 3. Commands ────────────────────────────────────────────────────────────

  pi.registerCommand('flow', {
    description: 'pi-flow status and agent management',
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- ExtensionCommandContext has rich UI APIs
    handler: async (_args: string, ctx: any) => {
      const options: string[] = [];

      // Session status always shown
      const statusLine = formatSessionStatus();

      // Running agents
      const agents = backgroundManager?.listAgents() ?? [];
      const running = agents.filter((a) => a.status === 'running' || a.status === 'queued');
      const completed = agents.filter((a) => a.status !== 'running' && a.status !== 'queued');

      if (running.length > 0 || completed.length > 0) {
        options.push(
          `Running agents (${agents.length}) — ${running.length} active, ${completed.length} done`,
        );
      }

      // Agent types
      const allAgents = discoverAgents(rootDir, ctx.cwd);
      options.push(`Agent types (${allAgents.length})`);

      // Actions
      options.push('Create new agent');
      options.push('Settings');

      const header = `[Flow Status]\n${statusLine}\n`;

      if (!ctx.ui?.select) {
        // No UI context — just show status
        pi.sendMessage({
          customType: 'pi-flow-status',
          content: header,
          display: true,
        });
        return;
      }

      const choice = await ctx.ui.select('pi-flow', options);
      if (!choice) return;

      if (choice.startsWith('Running agents')) {
        // Show running agents list
        if (agents.length === 0) {
          ctx.ui.notify?.('No agents.', 'info');
          return;
        }
        const agentOptions = agents.map((a) => {
          const dur = a.completedAt
            ? `${((a.completedAt - a.startedAt) / 1000).toFixed(1)}s`
            : `${((Date.now() - a.startedAt) / 1000).toFixed(1)}s (running)`;
          return `${a.agent.name} (${a.description}) · ${a.status} · ${dur}`;
        });
        const agentChoice = await ctx.ui.select('Running agents', agentOptions);
        if (!agentChoice) return;

        // Find selected agent
        const idx = agentOptions.indexOf(agentChoice);
        if (idx >= 0) {
          const record = agents[idx];
          if (record.session && ctx.ui.custom) {
            // Open conversation viewer
            const { FlowConversationViewer } = await import('./ui/conversation-viewer.js');
            const widgetActivity = agentActivity.get(record.id);
            await ctx.ui.custom(
              (tui: unknown, theme: unknown, _: unknown, done: (r: undefined) => void) => {
                return new FlowConversationViewer(
                  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- TUI interface is complex
                  tui as any,
                  record.session as {
                    messages: Array<{ role: string; content: unknown }>;
                    subscribe(fn: (e: { type: string }) => void): () => void;
                  },
                  record,
                  widgetActivity,
                  theme as { fg(c: string, t: string): string; bold(t: string): string },
                  done,
                );
              },
              { overlay: true, overlayOptions: { anchor: 'center', width: '90%' } },
            );
          } else {
            // Show result as text
            const output = record.result
              ? getFinalOutput(record.result.messages)
              : (record.error ?? 'No output.');
            pi.sendMessage({
              customType: 'pi-flow-agent-result',
              content: `Agent: ${record.agent.name}\nStatus: ${record.status}\n\n${output.slice(0, 2000)}`,
              display: true,
            });
          }
        }
      } else if (choice.startsWith('Agent types')) {
        const typeOptions = allAgents.map((a) => {
          const model = a.model || 'inherit';
          return `${a.name} · ${model} — ${a.description.split('.')[0]}`;
        });
        const typeChoice = await ctx.ui.select('Agent types', typeOptions);
        if (!typeChoice) return;

        // Show agent detail with actions
        const agentName = typeChoice.split(' · ')[0];
        const agent = allAgents.find((a) => a.name === agentName);
        if (agent) {
          const detail = [
            `Name: ${agent.name}`,
            `Label: ${agent.label}`,
            `Model: ${agent.model || 'inherit'}`,
            `Thinking: ${agent.thinking}`,
            `Tools: ${agent.tools.join(', ')}`,
            `Writable: ${agent.writable}`,
            `Source: ${agent.source}`,
            agent.memory ? `Memory: ${agent.memory}` : null,
            agent.isolation ? `Isolation: ${agent.isolation}` : null,
            agent.promptMode ? `Prompt mode: ${agent.promptMode}` : null,
            '',
            agent.description,
          ]
            .filter(Boolean)
            .join('\n');

          // Build action menu with proper CRUD (gaps 3-5)
          const actions: string[] = ['Back'];
          const isCustom = agent.source === 'custom';
          const isBuiltin = agent.source === 'builtin';
          if (isCustom && ctx.ui?.editor) actions.unshift('Edit');
          if (isCustom) actions.unshift('Delete');
          if (isBuiltin) actions.unshift('Eject (export as .md)');
          if (agent.enabled === false) {
            actions.unshift('Enable');
          } else {
            actions.unshift('Disable');
          }

          const actionChoice = await ctx.ui?.select?.(`${agent.name}\n\n${detail}`, actions);

          if (actionChoice === 'Edit' && ctx.ui?.editor) {
            // #99: Edit agent in TUI editor
            const { readFileSync, writeFileSync } = await import('node:fs');
            try {
              const content = readFileSync(agent.filePath, 'utf-8');
              const edited = await ctx.ui.editor(`Edit ${agent.name}`, content);
              if (edited !== undefined && edited !== content) {
                writeFileSync(agent.filePath, edited, 'utf-8');
                ctx.ui.notify?.(`Agent "${agent.name}" saved.`, 'info');
              }
            } catch (err: unknown) {
              ctx.ui.notify?.(
                `Failed to edit: ${err instanceof Error ? err.message : String(err)}`,
                'warning',
              );
            }
          } else if (actionChoice === 'Delete') {
            // Gap 5: Delete with confirmation dialog
            const confirmed = ctx.ui?.confirm
              ? await ctx.ui.confirm(
                  'Delete agent',
                  `Delete "${agent.name}" from ${agent.filePath}?`,
                )
              : true;
            if (confirmed) {
              const { unlinkSync } = await import('node:fs');
              try {
                unlinkSync(agent.filePath);
                ctx.ui.notify?.(`Agent "${agent.name}" deleted.`, 'info');
              } catch (err: unknown) {
                ctx.ui.notify?.(
                  `Failed to delete: ${err instanceof Error ? err.message : String(err)}`,
                  'warning',
                );
              }
            }
          } else if (actionChoice === 'Disable') {
            // Gap 4: Disable agent — patch frontmatter or create stub
            const {
              readFileSync: readFs,
              writeFileSync: writeFs,
              mkdirSync: mkFs,
            } = await import('node:fs');
            if (isCustom) {
              try {
                const content = readFs(agent.filePath, 'utf-8');
                if (!content.includes('\nenabled: false\n')) {
                  const updated = content.replace(/^---\n/, '---\nenabled: false\n');
                  writeFs(agent.filePath, updated, 'utf-8');
                }
                ctx.ui.notify?.(`Disabled "${agent.name}"`, 'info');
              } catch (err: unknown) {
                ctx.ui.notify?.(
                  `Failed: ${err instanceof Error ? err.message : String(err)}`,
                  'warning',
                );
              }
            } else {
              const customDir = path.join(ctx.cwd, '.flow', 'agents', 'custom');
              mkFs(customDir, { recursive: true });
              const stubPath = path.join(customDir, `${agent.name}.md`);
              writeFs(stubPath, '---\nenabled: false\n---\n', 'utf-8');
              ctx.ui.notify?.(`Disabled "${agent.name}" (${stubPath})`, 'info');
            }
          } else if (actionChoice === 'Enable') {
            // Gap 4: Enable agent — remove enabled: false or delete stub
            const {
              readFileSync: readFs,
              writeFileSync: writeFs,
              unlinkSync: unlinkFs,
            } = await import('node:fs');
            try {
              const content = readFs(agent.filePath, 'utf-8');
              const updated = content.replace(/^(---\n)enabled: false\n/, '$1');
              if (updated.trim() === '---\n---' || updated.trim() === '---\n---\n') {
                unlinkFs(agent.filePath);
                ctx.ui.notify?.(`Enabled "${agent.name}" (removed stub)`, 'info');
              } else {
                writeFs(agent.filePath, updated, 'utf-8');
                ctx.ui.notify?.(`Enabled "${agent.name}"`, 'info');
              }
            } catch (err: unknown) {
              ctx.ui.notify?.(
                `Failed: ${err instanceof Error ? err.message : String(err)}`,
                'warning',
              );
            }
          } else if (actionChoice?.startsWith('Eject')) {
            const { mkdirSync, writeFileSync, readFileSync } = await import('node:fs');
            const customDir = path.join(ctx.cwd, '.flow', 'agents', 'custom');
            mkdirSync(customDir, { recursive: true });
            const targetPath = path.join(customDir, `${agent.name}.md`);
            try {
              const content = readFileSync(agent.filePath, 'utf-8');
              writeFileSync(targetPath, content, 'utf-8');
              ctx.ui.notify?.(`Agent "${agent.name}" ejected to ${targetPath}`, 'info');
            } catch (err: unknown) {
              ctx.ui.notify?.(
                `Failed to eject: ${err instanceof Error ? err.message : String(err)}`,
                'warning',
              );
            }
          } else if (!actionChoice || actionChoice === 'Back') {
            // Do nothing
          }
        }
      } else if (choice === 'Create new agent') {
        // Gap 3: Agent creation wizard
        if (!ctx.ui?.input) {
          ctx.ui?.notify?.('UI not available for agent creation.', 'warning');
        } else {
          const name = await ctx.ui.input('Agent name (filename, no spaces)');
          if (name) {
            const description = await ctx.ui.input('Description (one line)');
            if (description) {
              const { mkdirSync, writeFileSync, existsSync } = await import('node:fs');
              const customDir = path.join(ctx.cwd, '.flow', 'agents', 'custom');
              mkdirSync(customDir, { recursive: true });
              const targetPath = path.join(customDir, `${name}.md`);
              if (existsSync(targetPath)) {
                const overwrite = ctx.ui?.confirm
                  ? await ctx.ui.confirm('Overwrite', `${targetPath} already exists. Overwrite?`)
                  : false;
                if (!overwrite) return;
              }
              let content = `---\nname: ${name}\ndescription: ${description}\ntools:\n  - read\n  - bash\n  - grep\n  - find\n  - ls\nthinking: medium\nwritable: false\n---\n\n`;
              if (ctx.ui?.editor) {
                const edited = await ctx.ui.editor(`Edit ${name} system prompt`, content);
                if (edited !== undefined) content = edited;
              }
              writeFileSync(targetPath, content, 'utf-8');
              ctx.ui.notify?.(`Created agent "${name}" at ${targetPath}`, 'info');
            }
          }
        }
      } else if (choice === 'Settings') {
        const { getGraceTurns, getDefaultMaxTurns, setGraceTurns, setDefaultMaxTurns } =
          await import('./runner.js');

        const settingChoice = await ctx.ui.select('Settings', [
          `Max concurrency (current: ${backgroundManager?.getMaxConcurrent() ?? 4})`,
          `Default max turns (current: ${getDefaultMaxTurns() ?? 'unlimited'})`,
          `Grace turns (current: ${getGraceTurns()})`,
        ]);
        if (!settingChoice) return;

        if (settingChoice.startsWith('Max concurrency') && ctx.ui.input) {
          const val = await ctx.ui.input(
            'Max concurrent background agents',
            String(backgroundManager?.getMaxConcurrent() ?? 4),
          );
          if (val) {
            const n = parseInt(val, 10);
            if (n >= 1) {
              backgroundManager?.setMaxConcurrent(n);
              ctx.ui.notify?.(`Max concurrency set to ${n}`, 'info');
            } else {
              ctx.ui.notify?.('Must be a positive integer.', 'warning');
            }
          }
        } else if (settingChoice.startsWith('Default max turns') && ctx.ui.input) {
          const val = await ctx.ui.input(
            'Default max turns (0 = unlimited)',
            String(getDefaultMaxTurns() ?? 0),
          );
          if (val) {
            const n = parseInt(val, 10);
            if (n === 0) {
              setDefaultMaxTurns(undefined);
              ctx.ui.notify?.('Default max turns set to unlimited', 'info');
            } else if (n >= 1) {
              setDefaultMaxTurns(n);
              ctx.ui.notify?.(`Default max turns set to ${n}`, 'info');
            } else {
              ctx.ui.notify?.('Must be 0 (unlimited) or a positive integer.', 'warning');
            }
          }
        } else if (settingChoice.startsWith('Grace turns') && ctx.ui.input) {
          const val = await ctx.ui.input(
            'Grace turns after wrap-up steer',
            String(getGraceTurns()),
          );
          if (val) {
            const n = parseInt(val, 10);
            if (n >= 1) {
              setGraceTurns(n);
              ctx.ui.notify?.(`Grace turns set to ${n}`, 'info');
            } else {
              ctx.ui.notify?.('Must be a positive integer.', 'warning');
            }
          }
        }
      }
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

  // session_switch — clear completed agents
  pi.on('session_switch' as 'session_start', async () => {
    backgroundManager?.clearCompleted();
  });

  // session_shutdown — abort all background agents, clean up RPC
  pi.on('session_shutdown' as 'session_start', async () => {
    rpcHandle.unsubPing();
    rpcHandle.unsubSpawn();
    rpcHandle.unsubStop();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- global registry cleanup
    delete (globalThis as any)[MANAGER_KEY];
    groupJoinManager?.dispose();
    backgroundManager?.dispose();
  });

  // tool_execution_start — grab UI context for widget + age finished agents
  pi.on('tool_execution_start', async (_event: unknown, ctx: ExtensionContext) => {
    if (ctx.hasUI) {
      // Widget is initialized lazily; grab from first tool execution
      updateFooterStatus(ctx.ui);
    }
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
