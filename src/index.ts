/**
 * pi-flow — Extension entry point.
 *
 * Wires together the dispatch_flow tool, /flow commands, and event hooks.
 * All business logic lives in the other modules; this file is pure wiring.
 *
 * Loaded by pi at runtime via: pi -e ./src/index.ts
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
  AgentEndEvent,
  SessionStartEvent,
  SessionBeforeCompactEvent,
  ToolCallEvent,
  ToolCallEventResult,
  ToolRenderResultOptions,
  AgentToolResult,
  AgentToolUpdateCallback,
} from '@mariozechner/pi-coding-agent';
import type { Theme } from '@mariozechner/pi-coding-agent';

import { executeDispatch } from './dispatch.js';
import { findFlowDir, readStateFile, writeCheckpoint, readCheckpoint } from './state.js';
import { discoverAgents } from './agents.js';
import { buildCoordinatorPrompt, buildNudgeMessage } from './prompt.js';
import {
  renderSingleCall,
  renderParallelCall,
  renderChainCall,
  renderFlowStatus,
  buildFlowResult,
} from './rendering.js';
import { hashToolCall, detectLoop } from './guardrails.js';
import { writeBackMemory } from './memory.js';
import type { FlowDispatchDetails, FlowState } from './types.js';

// ─── Module-level state ───────────────────────────────────────────────────────

// Loop detection ring buffer — reset on session_start.
const loopHistory: Array<{ tool: string; argsHash: string }> = [];
const LOOP_WINDOW = 10;
const LOOP_THRESHOLD = 3;

// Nudge guard — prevents sending more than one nudge per user input cycle.
let nudgedThisCycle = false;

// ─── Coordinator write whitelist ──────────────────────────────────────────────
//
// Per §14 S2: the coordinator may write anything inside .flow/.
// All production code files must be delegated to dispatch_flow(agent="builder").

function isAllowedCoordinatorWrite(filePath: string, cwd: string): boolean {
  const flowDir = findFlowDir(cwd);
  if (!flowDir) return false;
  const normalized = path.resolve(cwd, filePath);
  return normalized.startsWith(flowDir + path.sep) || normalized === flowDir;
}

// ─── Resume snapshot helpers ──────────────────────────────────────────────────

/** Extracts the ## Goal section body from spec.md content (capped at 400 chars). */
function extractGoalFromSpec(specContent: string): string {
  const match = /^## Goal\s*\n([\s\S]*?)(?=^## |\s*$)/m.exec(specContent);
  return match ? match[1].trim().slice(0, 400) : '(no spec goal)';
}

/** Extracts the tasks for a given wave from tasks.md content (capped at 800 chars). */
function extractWaveTasks(tasksContent: string, waveNum: number): string {
  const match = new RegExp(`^## Wave ${waveNum}\\s*\\n([\\s\\S]*?)(?=^## |\\s*$)`, 'm').exec(tasksContent);
  return match ? match[1].trim().slice(0, 800) : '(no tasks for this wave)';
}

/** Extracts the ## Decision section body from design.md content (capped at 400 chars). */
function extractChosenApproach(designContent: string): string {
  const match = /^## Decision\s*\n([\s\S]*?)(?=^## |\s*$)/m.exec(designContent);
  return match ? match[1].trim().slice(0, 400) : '(no design decision)';
}

// ─── Resume snapshot builder ──────────────────────────────────────────────────
//
// Builds a compact XML snapshot (<2KB) for injection after compaction.
// Priority-weighted: P1 data always survives budget pressure.

function buildResumeSnapshot(state: FlowState, featureDir: string): string {
  const safeRead = (name: string): string => {
    try {
      return fs.readFileSync(path.join(featureDir, name), 'utf8');
    } catch {
      return '';
    }
  };

  const specContent = safeRead('spec.md');
  const tasksContent = safeRead('tasks.md');
  const sentinelContent = safeRead('sentinel-log.md');
  const designContent = safeRead('design.md');

  const specGoal = extractGoalFromSpec(specContent);
  const waveTasks = extractWaveTasks(tasksContent, state.current_wave ?? 1);
  const chosenApproach = extractChosenApproach(designContent);

  // Sentinel issues excerpt (capped at 500 chars)
  const haltExcerpt =
    state.sentinel.open_halts > 0 ? sentinelContent.slice(0, 500) : '';

  return `<flow_resume
  feature="${state.feature}"
  phase="${state.current_phase}"
  wave="${state.current_wave ?? ''}"
  wave_count="${state.wave_count ?? ''}"
  timestamp="${new Date().toISOString()}"
  schema_version="1.0">

  <!-- P1: Always survives -->
  <spec_goal>${specGoal}</spec_goal>

  <current_wave_tasks><![CDATA[${waveTasks}]]></current_wave_tasks>

  <open_halts count="${state.sentinel.open_halts}">${haltExcerpt ? `<![CDATA[${haltExcerpt}]]>` : ''}</open_halts>

  <open_warns count="${state.sentinel.open_warns}" />

  <!-- P2: Important context -->
  <chosen_approach><![CDATA[${chosenApproach}]]></chosen_approach>

  <budget tokens_used="${state.budget.total_tokens}" cost_usd="${state.budget.total_cost_usd.toFixed(2)}" />

</flow_resume>`;
}

// ─── Status/budget formatters (used by commands) ──────────────────────────────

function formatStatusSummary(state: FlowState): string {
  const wave =
    state.current_wave !== null
      ? ` wave ${state.current_wave}/${state.wave_count ?? '?'}`
      : '';

  const lines: string[] = [
    `Feature: ${state.feature}`,
    `Phase:   ${state.current_phase.toUpperCase()}${wave}`,
    `Type:    ${state.change_type}`,
    '',
    'Budget',
    `  Tokens: ${state.budget.total_tokens.toLocaleString()}`,
    `  Cost:   $${state.budget.total_cost_usd.toFixed(4)}`,
    '',
    'Gates',
    `  Spec approved:   ${state.gates.spec_approved ? '✓' : '✗'}`,
    `  Design approved: ${state.gates.design_approved ? '✓' : '✗'}`,
    `  Review verdict:  ${state.gates.review_verdict ?? '(pending)'}`,
    '',
    'Sentinel',
    `  Open HALTs: ${state.sentinel.open_halts}`,
    `  Open WARNs: ${state.sentinel.open_warns}`,
  ];

  if (state.skipped_phases.length > 0) {
    lines.push('', `Skipped phases: ${state.skipped_phases.join(', ')}`);
  }

  return lines.join('\n');
}

function formatBudgetTable(state: FlowState): string {
  const lines: string[] = [
    `Feature: ${state.feature}`,
    `Phase:   ${state.current_phase.toUpperCase()}`,
    '',
    'Budget',
    `  Total tokens: ${state.budget.total_tokens.toLocaleString()}`,
    `  Total cost:   $${state.budget.total_cost_usd.toFixed(4)}`,
    '',
    'Sentinel Issues',
    `  Open HALTs: ${state.sentinel.open_halts}`,
    `  Open WARNs: ${state.sentinel.open_warns}`,
  ];
  return lines.join('\n');
}

// ─── Footer status helper ─────────────────────────────────────────────────────

function updateFooterStatus(state: FlowState, ui: ExtensionContext['ui']): void {
  const statusText = renderFlowStatus(
    state.feature,
    state.current_phase,
    state.current_wave,
    state.wave_count,
    state.budget.total_cost_usd,
    state.sentinel.open_halts,
    (color: string, t: string) => ui.theme.fg(color, t),
    (t: string) => ui.theme.bold(t),
  );
  ui.setStatus('pi-flow', statusText);
}

// ─── Active feature resolver ──────────────────────────────────────────────────
//
// Finds the first in-progress feature under .flow/features/.
// "In-progress" means state.md exists and current_phase is not 'ship' complete.

function findActiveFeature(cwd: string): { state: FlowState; featureDir: string } | null {
  const flowDir = findFlowDir(cwd);
  if (!flowDir) return null;

  const featuresDir = path.join(flowDir, 'features');
  if (!fs.existsSync(featuresDir)) return null;

  let entries: string[];
  try {
    entries = fs.readdirSync(featuresDir);
  } catch {
    return null;
  }

  for (const entry of entries) {
    const featureDir = path.join(featuresDir, entry);
    try {
      if (!fs.statSync(featureDir).isDirectory()) continue;
    } catch {
      continue;
    }
    const state = readStateFile(featureDir);
    if (!state) continue;
    return { state, featureDir };
  }

  return null;
}

// ─── Extension entry point ────────────────────────────────────────────────────

export default function piFlow(pi: ExtensionAPI) {
  const extensionDir = path.dirname(fileURLToPath(import.meta.url));
  // rootDir is one level up from src/ — needed for agents/ directory
  const rootDir = path.resolve(extensionDir, '..');

  // ─── 1. Tool: dispatch_flow ─────────────────────────────────────────────────

  pi.registerTool({
    name: 'dispatch_flow',
    label: 'Dispatch Flow Agent',
    description:
      'Dispatch specialized agents for pi-flow workflow phases. ' +
      'Modes: single (agent+task), parallel (all start simultaneously, good for Scouts), ' +
      'chain (sequential with {previous} substitution for prior output). ' +
      'The coordinator NEVER writes production code — use agent="builder" for all code changes.',
    promptSnippet:
      'Orchestrate software development via specialized subagents. ' +
      'Agents: clarifier (extract intent/spec), scout (read-only codebase analysis), ' +
      'strategist (design options), planner (wave task breakdown), ' +
      'builder (TDD implementation), sentinel (adversarial per-wave review), ' +
      'reviewer (final spec compliance), shipper (git/PR/docs). ' +
      'Use single for one agent, parallel for concurrent scouts, chain for sequential with {previous}.',
    parameters: Type.Object({
      agent: Type.Optional(
        Type.String({
          description: 'Agent name for single dispatch (clarifier/scout/strategist/planner/builder/sentinel/reviewer/shipper)',
        }),
      ),
      task: Type.Optional(
        Type.String({ description: 'Task description for single dispatch' }),
      ),
      parallel: Type.Optional(
        Type.Array(
          Type.Object({
            agent: Type.String({ description: 'Agent name' }),
            task: Type.String({ description: 'Task for this agent' }),
          }),
          {
            description: 'Parallel dispatch — all agents start simultaneously',
            maxItems: 8,
          },
        ),
      ),
      chain: Type.Optional(
        Type.Array(
          Type.Object({
            agent: Type.String({ description: 'Agent name' }),
            task: Type.String({
              description: 'Task. Use {previous} to reference the prior agent\'s output.',
            }),
          }),
          {
            description: 'Chain dispatch — sequential, each step receives prior output via {previous}',
          },
        ),
      ),
      phase: Type.String({
        description: 'Current workflow phase (intent/spec/analyze/plan/execute/review/ship)',
      }),
      feature: Type.String({
        description: 'Feature name (kebab-case), maps to .flow/features/<feature>/',
        minLength: 1,
        maxLength: 64,
      }),
      wave: Type.Optional(
        Type.Number({
          description: 'Current wave number within execute phase',
          minimum: 1,
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
        phase: string;
        feature: string;
        wave?: number;
      },
      signal: AbortSignal,
      onUpdate: AgentToolUpdateCallback<FlowDispatchDetails> | undefined,
      ctx: ExtensionContext,
    ) {
      const result = await executeDispatch(
        { ...params, phase: params.phase as import('./types.js').Phase },
        ctx.cwd,
        rootDir,
        signal,
        onUpdate
          ? (partial: { content: Array<{ type: 'text'; text: string }>; details: FlowDispatchDetails }) => {
              onUpdate({
                content: partial.content,
                details: partial.details,
              });
            }
          : undefined,
      );

      // Memory write-back after Shipper completes successfully (per §13 C5)
      const lastAgent = params.chain
        ? params.chain[params.chain.length - 1]?.agent
        : params.agent;
      if (lastAgent === 'shipper' && !result.isError) {
        const flowDir = findFlowDir(ctx.cwd);
        if (flowDir) {
          const featureDir = path.join(flowDir, 'features', params.feature);
          try {
            writeBackMemory(flowDir, featureDir);
          } catch {
            // Best-effort — memory write-back is non-fatal
          }
        }
      }

      // Update footer status from state.md after each dispatch
      if (ctx.hasUI) {
        const flowDir = findFlowDir(ctx.cwd);
        if (flowDir) {
          const featureDir = path.join(flowDir, 'features', params.feature);
          const state = readStateFile(featureDir);
          if (state) {
            updateFooterStatus(state, ctx.ui);
          }
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
      const colorize = (color: string, t: string): string => theme.fg(color, t);
      const bold = (t: string): string => theme.bold(t);

      let text: string;
      if (args.parallel && args.parallel.length > 0) {
        text = renderParallelCall(args.parallel, 'builtin', colorize, bold);
      } else if (args.chain && args.chain.length > 0) {
        text = renderChainCall(args.chain, 'builtin', colorize, bold);
      } else {
        text = renderSingleCall(
          args.agent ?? '...',
          args.task ?? '...',
          'builtin',
          colorize,
          bold,
        );
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

  // /flow — one-liner status
  pi.registerCommand('flow', {
    description: 'Show current workflow status (one-liner)',
    handler: async (_args: string, ctx: ExtensionCommandContext) => {
      const active = findActiveFeature(ctx.cwd);
      if (!active) {
        ctx.ui.notify('pi-flow: no active feature', 'info');
        return;
      }
      const { state } = active;
      const wave =
        state.current_wave !== null
          ? ` wave ${state.current_wave}/${state.wave_count ?? '?'}`
          : '';
      const halts =
        state.sentinel.open_halts > 0
          ? ` | ${state.sentinel.open_halts} HALT`
          : '';
      const cost = `$${state.budget.total_cost_usd.toFixed(2)}`;
      ctx.ui.notify(
        `${state.feature} | ${state.current_phase.toUpperCase()}${wave} | ${cost}${halts}`,
        'info',
      );
    },
  });

  // /flow:status — detailed status
  pi.registerCommand('flow:status', {
    description: 'Detailed workflow status with budget breakdown and gate conditions',
    handler: async (_args: string, ctx: ExtensionCommandContext) => {
      const active = findActiveFeature(ctx.cwd);
      if (!active) {
        ctx.ui.notify(
          'pi-flow: no active feature. Start one by describing what to build.',
          'info',
        );
        return;
      }
      const summary = formatStatusSummary(active.state);
      pi.sendMessage(
        { customType: 'pi-flow-status', content: `[Flow Status]\n\n${summary}`, display: true },
        { triggerTurn: false },
      );
    },
  });

  // /flow:budget — cost breakdown
  pi.registerCommand('flow:budget', {
    description: 'Show token and cost breakdown for the current feature',
    handler: async (_args: string, ctx: ExtensionCommandContext) => {
      const active = findActiveFeature(ctx.cwd);
      if (!active) {
        ctx.ui.notify('pi-flow: no active feature', 'info');
        return;
      }
      const table = formatBudgetTable(active.state);
      pi.sendMessage(
        { customType: 'pi-flow-budget', content: `[Flow Budget]\n\n${table}`, display: true },
        { triggerTurn: false },
      );
    },
  });

  // /flow:reset [feature] — delete all state for a feature
  pi.registerCommand('flow:reset', {
    description:
      'Reset workflow state for a feature (deletes phase files and checkpoints). ' +
      'Usage: /flow:reset  or  /flow:reset <feature-name>',
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      const flowDir = findFlowDir(ctx.cwd);
      if (!flowDir) {
        ctx.ui.notify('pi-flow: no .flow/ directory found', 'warn');
        return;
      }

      // Resolve target feature: arg > active feature
      const active = findActiveFeature(ctx.cwd);
      const target = args.trim() || active?.state.feature;
      if (!target) {
        ctx.ui.notify(
          'pi-flow: no feature to reset. Usage: /flow:reset <feature-name>',
          'warn',
        );
        return;
      }

      const featureDir = path.join(flowDir, 'features', target);
      if (!fs.existsSync(featureDir)) {
        ctx.ui.notify(`pi-flow: feature '${target}' not found`, 'warn');
        return;
      }

      const confirmed = await ctx.ui.confirm(
        `Reset '${target}'?`,
        `This will permanently delete:\n` +
          `  • .flow/features/${target}/  (spec, design, tasks, logs, checkpoints)\n\n` +
          `Memory files (.flow/memory/) are NOT deleted.`,
      );
      if (!confirmed) return;

      try {
        fs.rmSync(featureDir, { recursive: true, force: true });
        ctx.ui.setStatus('pi-flow', undefined);
        ctx.ui.notify(`pi-flow: '${target}' reset — all phase files deleted`, 'info');
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        ctx.ui.notify(`pi-flow: reset failed — ${msg}`, 'error');
      }
    },
  });

  // ─── 3. Event hooks ─────────────────────────────────────────────────────────

  // input — reset nudge guard at the start of each user input cycle
  pi.on('input', async () => {
    nudgedThisCycle = false;
  });

  // before_agent_start — inject coordinator prompt into system prompt
  pi.on('before_agent_start', async (event: BeforeAgentStartEvent, ctx: ExtensionContext) => {
    try {
      const agents = discoverAgents(rootDir, ctx.cwd);
      const active = findActiveFeature(ctx.cwd);
      const prompt = buildCoordinatorPrompt(agents, active);
      return { systemPrompt: event.systemPrompt + '\n\n' + prompt };
    } catch {
      return {
        systemPrompt:
          event.systemPrompt +
          '\n\n## Coordinator\n\nYou have `dispatch_flow` available for orchestrating development. Use /flow for status.',
      };
    }
  });

  // agent_end — nudge coordinator to continue if a workflow is in progress
  pi.on('agent_end', async (_event: AgentEndEvent, ctx: ExtensionContext) => {
    const active = findActiveFeature(ctx.cwd);
    if (!active) return;
    if (active.state.current_phase === 'ship') return;
    if (nudgedThisCycle) return;
    nudgedThisCycle = true;
    pi.sendMessage(
      {
        customType: 'pi-flow-nudge',
        content: buildNudgeMessage(active.state),
        display: true,
      },
      { triggerTurn: true },
    );
  });

  // session_start — restore footer status for any in-progress feature
  pi.on('session_start', async (_event: SessionStartEvent, ctx: ExtensionContext) => {
    // Reset loop detection history for this session
    loopHistory.length = 0;

    if (!ctx.hasUI) return;

    const active = findActiveFeature(ctx.cwd);
    if (!active) return;

    const { state, featureDir } = active;

    // Notify user of the in-progress feature
    const wave =
      state.current_wave !== null
        ? ` wave ${state.current_wave}/${state.wave_count ?? '?'}`
        : '';
    ctx.ui.notify(
      `pi-flow: resuming '${state.feature}' — ${state.current_phase.toUpperCase()}${wave}`,
      'info',
    );

    // Restore footer status
    updateFooterStatus(state, ctx.ui);

    // If there is a checkpoint, remind the coordinator to resume
    const checkpoint = readCheckpoint(featureDir);
    if (checkpoint) {
      // Use sendMessage to inject the resume snapshot into the next turn
      pi.sendMessage(
        {
          customType: 'pi-flow-resume',
          content:
            `You have an in-progress pi-flow feature: '${state.feature}' at phase ${state.current_phase.toUpperCase()}${wave}.\n\n` +
            `Resume checkpoint:\n\n${checkpoint}\n\n` +
            `Type /flow for a one-line status or /flow:status for full details.`,
          display: false,
        },
        { deliverAs: 'nextTurn' },
      );
    }
  });

  // tool_call — block coordinator writes outside .flow/ and detect loops
  pi.on('tool_call', async (event: ToolCallEvent, ctx: ExtensionContext): Promise<ToolCallEventResult | void> => {
    const toolName: string = event.toolName;
    const args: Record<string, unknown> =
      (event as { toolName: string; input: Record<string, unknown> }).input ?? {};

    // Loop detection (runs for all tools)
    const argsHash = hashToolCall(toolName, args);
    loopHistory.push({ tool: toolName, argsHash });
    // Keep the ring buffer bounded
    if (loopHistory.length > LOOP_WINDOW * 2) {
      loopHistory.splice(0, loopHistory.length - LOOP_WINDOW * 2);
    }
    const loopResult = detectLoop(loopHistory, LOOP_WINDOW, LOOP_THRESHOLD);
    if (loopResult.tripped) {
      return {
        block: true,
        reason:
          `CIRCUIT BREAKER: '${loopResult.tool}' has been called with identical ` +
          `arguments ${loopResult.count} times in the last ${LOOP_WINDOW} tool calls. ` +
          `This is a loop. Stop immediately. In one sentence, state what you are trying ` +
          `to accomplish. Then either write code or report a blocker.`,
      };
    }

    // Write/edit isolation: coordinator may only write inside .flow/
    if (toolName === 'write' || toolName === 'edit') {
      const filePath = (args.path ?? args.file_path ?? args.filePath ?? '') as string;
      if (filePath && !isAllowedCoordinatorWrite(filePath, ctx.cwd)) {
        return {
          block: true,
          reason:
            `Coordinator cannot write to '${filePath}' directly. ` +
            `All production code changes must be delegated via dispatch_flow(agent="builder"). ` +
            `Only paths inside .flow/ may be written by the coordinator.`,
        };
      }
    }
  });

  // session_before_compact — write a resume snapshot before context is lost
  pi.on('session_before_compact', async (_event: SessionBeforeCompactEvent, ctx: ExtensionContext) => {
    const active = findActiveFeature(ctx.cwd);
    if (!active) return;

    const { state, featureDir } = active;
    try {
      const snapshot = buildResumeSnapshot(state, featureDir);
      writeCheckpoint(featureDir, state.current_phase, state.current_wave, snapshot);
    } catch {
      // Checkpoint writing is best-effort — non-fatal during compaction
    }
  });
}
