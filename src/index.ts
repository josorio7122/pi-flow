/**
 * pi-flow v2 — Extension entry point.
 *
 * Simplified: no state machine, no gates, no nudges.
 * The coordinator decides the workflow. The extension provides tools,
 * enforces tool blocking, tracks budget, and writes artifacts.
 */

import { fileURLToPath } from 'node:url';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { Type } from '@sinclair/typebox';
import { Text } from '@mariozechner/pi-tui';
import type {
  ExtensionAPI,
  ExtensionContext,
  ExtensionCommandContext,
  BeforeAgentStartEvent,
  SessionStartEvent,
  ToolCallEvent,
  ToolCallEventResult,
  ToolRenderResultOptions,
  AgentToolResult,
  AgentToolUpdateCallback,
} from '@mariozechner/pi-coding-agent';
import type { Theme, ThemeColor } from '@mariozechner/pi-coding-agent';

import { executeDispatch } from './dispatch.js';
import { findFlowDir, readStateFile } from './state.js';
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
import type { FlowDispatchDetails, FlowState } from './types.js';

// ─── Module-level state ───────────────────────────────────────────────────────

const loopHistory: Array<{ tool: string; argsHash: string }> = [];
const LOOP_WINDOW = 10;
const LOOP_THRESHOLD = 3;

// ─── Coordinator write whitelist ──────────────────────────────────────────────

function isAllowedCoordinatorWrite(filePath: string, cwd: string): boolean {
  const flowDir = findFlowDir(cwd);
  if (!flowDir) return false;
  const normalized = path.resolve(cwd, filePath);
  return normalized.startsWith(flowDir + path.sep) || normalized === flowDir;
}

// ─── Active feature finder ───────────────────────────────────────────────────

function findActiveFeature(
  cwd: string,
): { state: FlowState; featureDir: string } | null {
  const flowDir = findFlowDir(cwd);
  if (!flowDir) return null;

  const featuresDir = path.join(flowDir, 'features');
  let entries: string[];
  try {
    entries = fs.readdirSync(featuresDir);
  } catch {
    return null;
  }

  // Return the most recently updated feature
  let latest: { state: FlowState; featureDir: string } | null = null;
  let latestTime = 0;

  for (const entry of entries) {
    const featureDir = path.join(featuresDir, entry);
    try {
      if (!fs.statSync(featureDir).isDirectory()) continue;
    } catch {
      continue;
    }
    const state = readStateFile(featureDir);
    if (!state) continue;
    const time = new Date(state.last_updated).getTime();
    if (time > latestTime) {
      latestTime = time;
      latest = { state, featureDir };
    }
  }

  return latest;
}

// ─── Status helpers ──────────────────────────────────────────────────────────

function formatStatusSummary(state: FlowState): string {
  return [
    `Feature: ${state.feature}`,
    '',
    'Budget',
    `  Tokens: ${state.budget.total_tokens.toLocaleString()}`,
    `  Cost:   $${state.budget.total_cost_usd.toFixed(4)}`,
  ].join('\n');
}

function formatBudgetTable(state: FlowState): string {
  return [
    `Feature: ${state.feature}`,
    '',
    `Tokens: ${state.budget.total_tokens.toLocaleString()}`,
    `Cost:   $${state.budget.total_cost_usd.toFixed(4)}`,
  ].join('\n');
}

function updateFooterStatus(state: FlowState, ui: ExtensionContext['ui']): void {
  const cost = `$${state.budget.total_cost_usd.toFixed(2)}`;
  const status = `● ${state.feature}  |  ${cost}`;
  try {
    (ui as unknown as { setStatus: (...args: unknown[]) => void }).setStatus('pi-flow', status);
  } catch {
    // setStatus may not be available in all pi versions
  }
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
      'Dispatch specialized subagents: scout (read-only analysis), ' +
      'planner (wave task breakdown), builder (TDD implementation), ' +
      'reviewer (spec compliance + security). ' +
      'Feature is auto-inferred from active feature.',
    parameters: Type.Object({
      agent: Type.Optional(
        Type.String({ description: 'Agent name (scout/planner/builder/reviewer)' }),
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
          minLength: 1,
          maxLength: 64,
        }),
      ),
    }),

    async execute(
      _toolCallId: string,
      params: {
        agent?: string;
        task?: string;
        parallel?: Array<{ agent: string; task: string }>;
        chain?: Array<{ agent: string; task: string }>;
        feature?: string;
      },
      signal: AbortSignal,
      onUpdate: AgentToolUpdateCallback<FlowDispatchDetails> | undefined,
      ctx: ExtensionContext,
    ) {
      // Infer feature from active state if not provided
      const activeFeature = findActiveFeature(ctx.cwd);
      const feature = params.feature ?? activeFeature?.state.feature;
      if (!feature) {
        return {
          content: [{ type: 'text' as const, text: 'No active feature. Provide a feature name to start.' }],
          details: undefined as unknown as FlowDispatchDetails,
          isError: true,
        };
      }

      const result = await executeDispatch(
        { ...params, feature },
        ctx.cwd,
        rootDir,
        signal,
        onUpdate
          ? (partial: { content: Array<{ type: 'text'; text: string }>; details: FlowDispatchDetails }) => {
              onUpdate({ content: partial.content, details: partial.details });
            }
          : undefined,
      );

      // Update footer status
      if (ctx.hasUI) {
        const flowDir = findFlowDir(ctx.cwd);
        if (flowDir) {
          const featureDir = path.join(flowDir, 'features', feature);
          const state = readStateFile(featureDir);
          if (state) updateFooterStatus(state, ctx.ui);
        }
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
    ) {
      const colorize = (color: string, t: string): string => theme.fg(color as ThemeColor, t);
      const bold = (t: string): string => theme.bold(t);

      let text: string;
      if (args.parallel && args.parallel.length > 0) {
        text = renderParallelCall(args.parallel, 'builtin', colorize, bold);
      } else if (args.chain && args.chain.length > 0) {
        text = renderChainCall(args.chain, 'builtin', colorize, bold);
      } else {
        text = renderSingleCall(args.agent ?? '...', args.task ?? '...', 'builtin', colorize, bold);
      }

      return new Text(text, 0, 0);
    },

    renderResult(
      result: AgentToolResult<FlowDispatchDetails>,
      options: ToolRenderResultOptions,
      theme: Theme,
    ) {
      const details = result.details as FlowDispatchDetails | undefined;
      if (!details || details.results.length === 0) {
        const first = result.content[0];
        return new Text(first?.type === 'text' ? first.text : '(no output)', 0, 0);
      }
      return buildFlowResult(details, options, theme);
    },
  });

  // ─── 2. Commands ────────────────────────────────────────────────────────────

  pi.registerCommand('flow', {
    description: 'Show pi-flow status',
    handler: async (_args: string, ctx: ExtensionCommandContext) => {
      const active = findActiveFeature(ctx.cwd);
      if (!active) {
        pi.sendMessage({ customType: 'pi-flow-status', content: 'No active pi-flow feature.', display: true });
        return;
      }
      const summary = formatStatusSummary(active.state);
      pi.sendMessage({ customType: 'pi-flow-status', content: `[Flow Status]\n\n${summary}`, display: true });
    },
  });

  pi.registerCommand('flow:budget', {
    description: 'Show pi-flow budget details',
    handler: async (_args: string, ctx: ExtensionCommandContext) => {
      const active = findActiveFeature(ctx.cwd);
      if (!active) {
        pi.sendMessage({ customType: 'pi-flow-budget', content: 'No active pi-flow feature.', display: true });
        return;
      }
      const table = formatBudgetTable(active.state);
      pi.sendMessage({ customType: 'pi-flow-budget', content: `[Flow Budget]\n\n${table}`, display: true });
    },
  });

  // ─── 3. Event hooks ─────────────────────────────────────────────────────────

  // before_agent_start — inject coordinator prompt
  pi.on('before_agent_start', async (event: BeforeAgentStartEvent, ctx: ExtensionContext) => {
    try {
      const agents = discoverAgents(rootDir, ctx.cwd);
      const skills = discoverSkills(rootDir, ctx.cwd);
      const active = findActiveFeature(ctx.cwd);
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

  // session_start — restore footer status
  pi.on('session_start', async (_event: SessionStartEvent, ctx: ExtensionContext) => {
    loopHistory.length = 0;
    if (!ctx.hasUI) return;
    const active = findActiveFeature(ctx.cwd);
    if (!active) return;
    updateFooterStatus(active.state, ctx.ui);
  });

  // tool_call — enforce coordinator write restrictions + loop detection
  pi.on(
    'tool_call',
    async (event: ToolCallEvent, ctx: ExtensionContext): Promise<ToolCallEventResult> => {
      const name = event.toolName;
      const input = event.input as Record<string, unknown>;

      // Tool blocking: coordinator can't write outside .flow/
      if (name === 'Write' || name === 'Edit') {
        const filePath = input.path as string | undefined;
        if (filePath && !isAllowedCoordinatorWrite(filePath, ctx.cwd)) {
          return {
            block: true,
            reason:
              `Coordinator cannot write to '${filePath}'. ` +
              'Dispatch builder for code changes. You may only write inside .flow/.',
          };
        }
      }

      // Loop detection
      const hash = hashToolCall(name, input);
      loopHistory.push({ tool: name, argsHash: hash });
      if (loopHistory.length > LOOP_WINDOW) loopHistory.shift();

      const loop = detectLoop(loopHistory, LOOP_WINDOW, LOOP_THRESHOLD);
      if (loop) {
        return {
          block: true,
          reason: `Loop detected: '${loop.tool}' called ${loop.count} times with identical args. Try a different approach.`,
        };
      }

      return {};
    },
  );
}
