import * as path from 'node:path';
import * as fs from 'node:fs';
import { getNextPhase } from './transitions.js';
import type {
  FlowAgentConfig,
  FlowConfig,
  FlowDispatchDetails,
  FlowState,
  Phase,
  SingleAgentResult,
} from './types.js';
import { loadConfig } from './config.js';
import { discoverAgents, buildVariableMap } from './agents.js';
import { spawnAgentWithRetry, mapWithConcurrencyLimit, getFinalOutput } from './spawn.js';
import {
  readStateFile,
  writeDispatchLog,
  writeStateFile,
  ensureFeatureDir,
  appendProgressLog,
  writeCheckpoint,
} from './state.js';
import { checkPhaseGate } from './gates.js';

// ─── Public types ─────────────────────────────────────────────────────────────

export interface DispatchParams {
  // Single mode
  agent?: string;
  task?: string;

  // Parallel mode
  parallel?: Array<{ agent: string; task: string }>;

  // Chain mode
  chain?: Array<{ agent: string; task: string }>;

  // Context
  phase: Phase;
  feature: string;
  wave?: number;
}

export interface DispatchResult {
  content: Array<{ type: 'text'; text: string }>;
  details: FlowDispatchDetails;
  isError?: boolean;
}

export type OnUpdateCallback = (partial: DispatchResult) => void;

// ─── Pure helpers (exported for testing) ─────────────────────────────────────

/**
 * Returns the agent from `agents` whose name matches `name`, or null if none found.
 */
export function findAgent(agents: FlowAgentConfig[], name: string): FlowAgentConfig | null {
  return agents.find((a) => a.name === name) ?? null;
}

/**
 * Checks whether `agent.phases` includes the given `phase`.
 * Returns `{ allowed, reason }`.
 */
export function validateAgentPhase(
  agent: FlowAgentConfig,
  phase: Phase,
): { allowed: boolean; reason: string } {
  if (agent.phases.includes(phase)) {
    return {
      allowed: true,
      reason: `agent '${agent.name}' is allowed in phase '${phase}'`,
    };
  }
  return {
    allowed: false,
    reason:
      `agent '${agent.name}' is not allowed in phase '${phase}'. ` +
      `Allowed phases: ${agent.phases.join(', ')}`,
  };
}

/**
 * Finds and validates all agent+task pairs for parallel or chain dispatch.
 * Returns `{ resolved }` on success or `{ error }` if any agent is missing or
 * is not allowed in the given phase.
 */
export function resolveAgentTasks(
  items: Array<{ agent: string; task: string }>,
  agents: FlowAgentConfig[],
  phase: Phase,
): { resolved: Array<{ agent: FlowAgentConfig; task: string }> } | { error: string } {
  const resolved: Array<{ agent: FlowAgentConfig; task: string }> = [];
  for (const { agent: agentName, task } of items) {
    const agent = findAgent(agents, agentName);
    if (!agent) {
      return {
        error: `Agent '${agentName}' not found. Available agents: ${agents.map((a) => a.name).join(', ')}`,
      };
    }
    const check = validateAgentPhase(agent, phase);
    if (!check.allowed) {
      return { error: `Phase validation failed: ${check.reason}` };
    }
    resolved.push({ agent, task });
  }
  return { resolved };
}

/**
 * Factory that creates a `FlowDispatchDetails` builder bound to the given
 * mode, phase, and feature. Call the returned function with the results array
 * to produce the final details object.
 */
export function makeDetails(
  mode: 'single' | 'parallel' | 'chain',
  phase: Phase,
  feature: string,
): (results: SingleAgentResult[]) => FlowDispatchDetails {
  return (results) => ({ mode, phase, feature, results });
}

/**
 * Sums input+output tokens and cost across an array of SingleAgentResults for budget tracking.
 * Returns `{ tokens, cost }` — distinct from spawn.ts `aggregateUsage` which returns `UsageStats`.
 */
function sumBudget(results: SingleAgentResult[]): { tokens: number; cost: number } {
  return results.reduce(
    (acc, r) => ({
      tokens: acc.tokens + r.usage.input + r.usage.output,
      cost: acc.cost + r.usage.cost,
    }),
    { tokens: 0, cost: 0 },
  );
}

// ─── Internal executors ───────────────────────────────────────────────────────

async function executeSingle(
  agent: FlowAgentConfig,
  task: string,
  cwd: string,
  variableMap: Record<string, string>,
  _config: FlowConfig,
  phase: Phase,
  feature: string,
  signal?: AbortSignal,
  onUpdate?: OnUpdateCallback,
): Promise<SingleAgentResult> {
  const buildDetailsForUpdate = makeDetails('single', phase, feature);

  const onAgentUpdate = onUpdate
    ? (result: SingleAgentResult) => {
        onUpdate({
          content: [{ type: 'text', text: getFinalOutput(result.messages) }],
          details: buildDetailsForUpdate([result]),
        });
      }
    : undefined;

  const result = await spawnAgentWithRetry(cwd, agent, task, variableMap, signal, onAgentUpdate);

  // Write dispatch log after the agent completes
  const flowDir = path.join(cwd, '.flow');
  writeDispatchLog(flowDir, feature, {
    agent: agent.name,
    task,
    phase,
    exitCode: result.exitCode,
    usage: result.usage,
  });

  return result;
}

async function executeParallel(
  agentTasks: Array<{ agent: FlowAgentConfig; task: string }>,
  cwd: string,
  variableMap: Record<string, string>,
  config: FlowConfig,
  phase: Phase,
  feature: string,
  signal?: AbortSignal,
  onUpdate?: OnUpdateCallback,
): Promise<SingleAgentResult[]> {
  const buildDetailsForUpdate = makeDetails('parallel', phase, feature);

  // Create placeholder entries so combined updates can reference all slots
  const results: SingleAgentResult[] = agentTasks.map(({ agent, task }) => ({
    agent: agent.name,
    agentSource: agent.source,
    task,
    exitCode: -1,
    messages: [],
    stderr: '',
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      cost: 0,
      contextTokens: 0,
      turns: 0,
    },
  }));

  await mapWithConcurrencyLimit(
    agentTasks,
    config.concurrency.max_workers,
    async ({ agent, task }, index) => {
      const onAgentUpdate = onUpdate
        ? (result: SingleAgentResult) => {
            results[index] = result;
            onUpdate({
              content: results.map((r) => ({
                type: 'text' as const,
                text: getFinalOutput(r.messages),
              })),
              details: buildDetailsForUpdate([...results]),
            });
          }
        : undefined;

      const result = await spawnAgentWithRetry(
        cwd,
        agent,
        task,
        variableMap,
        signal,
        onAgentUpdate,
      );

      results[index] = result;

      // Write dispatch log after each agent completes
      const flowDir = path.join(cwd, '.flow');
      writeDispatchLog(flowDir, feature, {
        agent: agent.name,
        task,
        phase,
        exitCode: result.exitCode,
        usage: result.usage,
      });

      return result;
    },
  );

  return results;
}

async function executeChain(
  steps: Array<{ agent: FlowAgentConfig; task: string }>,
  cwd: string,
  variableMap: Record<string, string>,
  _config: FlowConfig,
  phase: Phase,
  feature: string,
  signal?: AbortSignal,
  onUpdate?: OnUpdateCallback,
): Promise<SingleAgentResult[]> {
  const buildDetailsForUpdate = makeDetails('chain', phase, feature);
  const flowDir = path.join(cwd, '.flow');

  // Pre-create full-length placeholder array so onUpdate always reports N/N
  const allResults: SingleAgentResult[] = steps.map(({ agent, task: rawTask }) => ({
    agent: agent.name,
    agentSource: agent.source,
    task: rawTask,
    exitCode: -1,
    messages: [],
    stderr: '',
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      cost: 0,
      contextTokens: 0,
      turns: 0,
    },
  }));

  // Track completed results separately for {previous} substitution
  const completedResults: SingleAgentResult[] = [];

  for (let i = 0; i < steps.length; i++) {
    const { agent, task: rawTask } = steps[i];

    // Replace all {previous} occurrences with the prior agent's final output
    const previousOutput =
      completedResults.length > 0
        ? getFinalOutput(completedResults[completedResults.length - 1].messages)
        : '';
    const task = rawTask.replace(/\{previous\}/g, previousOutput);

    const onAgentUpdate = onUpdate
      ? (result: SingleAgentResult) => {
          allResults[i] = result;
          onUpdate({
            content: allResults.map((r) => ({
              type: 'text' as const,
              text: getFinalOutput(r.messages),
            })),
            details: buildDetailsForUpdate([...allResults]),
          });
        }
      : undefined;

    const result = await spawnAgentWithRetry(cwd, agent, task, variableMap, signal, onAgentUpdate);

    // Update the placeholder in-place with the actual result
    allResults[i] = result;
    completedResults.push(result);

    // Write dispatch log for this step
    writeDispatchLog(flowDir, feature, {
      agent: agent.name,
      task,
      phase,
      step: i + 1,
      exitCode: result.exitCode,
      usage: result.usage,
    });

    // Emit accumulated update after each step (covers cases where the
    // agent's own callback was never invoked, e.g. in tests)
    if (onUpdate) {
      onUpdate({
        content: allResults.map((r) => ({
          type: 'text' as const,
          text: getFinalOutput(r.messages),
        })),
        details: buildDetailsForUpdate([...allResults]),
      });
    }

    // Stop chain on error — truncate to attempted steps only
    if (result.exitCode !== 0) {
      return allResults.slice(0, i + 1);
    }
  }

  // All steps completed — return full array
  return allResults;
}

// ─── State initializer ────────────────────────────────────────────────────────

/**
 * Reads existing state for `featureDir`, or creates and writes a fresh
 * `FlowState` when no state.md exists yet. Returns the state (which may be
 * null only if both reading and writing fail).
 *
 * State-init failure is non-fatal — the caller proceeds without state tracking.
 */
function initializeState(
  cwd: string,
  featureDir: string,
  params: DispatchParams,
): FlowState | null {
  const existing = readStateFile(featureDir);
  if (existing) return existing;

  try {
    ensureFeatureDir(cwd, params.feature);
    const fresh: FlowState = {
      feature: params.feature,
      change_type: 'feature',
      current_phase: params.phase,
      current_wave: params.wave ?? null,
      wave_count: null,
      skipped_phases: [],
      started_at: new Date().toISOString(),
      last_updated: new Date().toISOString(),
      budget: { total_tokens: 0, total_cost_usd: 0 },
      gates: { spec_approved: false, design_approved: false, review_verdict: null },
      sentinel: { open_halts: 0, open_warns: 0 },
    } satisfies FlowState;
    writeStateFile(featureDir, fresh);
    return fresh;
  } catch {
    // State init failure is non-fatal — proceed without state tracking
    return null;
  }
}

// ─── Public entry point ───────────────────────────────────────────────────────

/**
 * Main orchestration function. Routes to executeSingle, executeParallel, or
 * executeChain based on the params shape. Discovers agents, builds the
 * variable map, validates phases, then dispatches.
 */
export async function executeDispatch(
  params: DispatchParams,
  cwd: string,
  extensionDir: string,
  signal?: AbortSignal,
  onUpdate?: OnUpdateCallback,
): Promise<DispatchResult> {
  try {
    // a. Load config
    const config = loadConfig(cwd);

    // e. Build variable map (done once, shared across all agents)
    const featureDir = path.join(cwd, '.flow', 'features', params.feature);

    // State initialization: create state.md if this is the first dispatch for this feature
    const currentState = initializeState(cwd, featureDir, params);

    // Gate enforcement: check if the workflow can advance to this phase
    try {
      const gate = checkPhaseGate(
        params.phase,
        featureDir,
        currentState?.change_type,
        currentState?.skipped_phases,
      );
      if (!gate.canAdvance) {
        return errorResult(`Gate blocked for phase '${params.phase}': ${gate.reason}`, params);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return errorResult(`Gate check failed: ${message}`, params);
    }

    // b. Discover agents
    const agents = discoverAgents(extensionDir, cwd);

    const variableMap = buildVariableMap(cwd, featureDir, currentState);

    // f. Route to the appropriate executor

    if (params.parallel) {
      // c. Find and validate all parallel agents
      const resolved = resolveAgentTasks(params.parallel, agents, params.phase);
      if ('error' in resolved) return errorResult(resolved.error, params);

      const results = await executeParallel(
        resolved.resolved,
        cwd,
        variableMap,
        config,
        params.phase,
        params.feature,
        signal,
        onUpdate,
      );
      const details = makeDetails('parallel', params.phase, params.feature)(results);

      accumulateBudget(featureDir, currentState, results, params, true);

      return {
        content: buildContent(results),
        details,
      };
    }

    if (params.chain) {
      // c. Find and validate all chain agents
      const resolvedChain = resolveAgentTasks(params.chain, agents, params.phase);
      if ('error' in resolvedChain) return errorResult(resolvedChain.error, params);
      const steps = resolvedChain.resolved;

      const results = await executeChain(
        steps,
        cwd,
        variableMap,
        config,
        params.phase,
        params.feature,
        signal,
        onUpdate,
      );
      const details = makeDetails('chain', params.phase, params.feature)(results);

      // Only checkpoint if all steps succeeded
      const chainSuccess =
        results.length === steps.length && results.every((r) => r.exitCode === 0);
      accumulateBudget(featureDir, currentState, results, params, chainSuccess);

      return {
        content: buildContent(results),
        details,
      };
    }

    // Single mode
    const agentName = params.agent;
    const task = params.task;

    if (!agentName || !task) {
      return errorResult('dispatch_flow requires one of: agent+task, parallel, or chain.', params);
    }

    // c. Find agent
    const agent = findAgent(agents, agentName);
    if (!agent) {
      return errorResult(
        `Agent '${agentName}' not found. Available agents: ${agents.map((a) => a.name).join(', ')}`,
        params,
      );
    }

    // d. Validate agent phase
    const phaseCheck = validateAgentPhase(agent, params.phase);
    if (!phaseCheck.allowed) {
      return errorResult(`Phase validation failed: ${phaseCheck.reason}`, params);
    }

    const result = await executeSingle(
      agent,
      task,
      cwd,
      variableMap,
      config,
      params.phase,
      params.feature,
      signal,
      onUpdate,
    );
    const details = makeDetails('single', params.phase, params.feature)([result]);

    accumulateBudget(featureDir, currentState, [result], params, true);

    return {
      content: buildContent([result]),
      details,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return errorResult(message, params);
  }
}

// ─── Private helpers ──────────────────────────────────────────────────────────

/**
 * Updates state budget from execution results, writes state file, appends
 * a progress log entry, and optionally writes a checkpoint.
 * All failures are swallowed — budget/log/checkpoint loss is acceptable.
 */
function accumulateBudget(
  featureDir: string,
  currentState: FlowState | null,
  results: SingleAgentResult[],
  params: DispatchParams,
  writeCheckpointOnSuccess: boolean,
): void {
  if (!currentState) return;
  try {
    const usage = sumBudget(results);
    const allSucceeded = results.every((r) => r.exitCode === 0);

    // Determine the next phase: auto-advance on success, stay on current on failure.
    // For wave-based execute: only advance after the final wave.
    let nextPhase = params.phase;
    if (allSucceeded) {
      const hasMoreWaves =
        params.wave !== undefined &&
        (currentState.wave_count === null || params.wave < currentState.wave_count);

      if (!hasMoreWaves) {
        const advanced = getNextPhase(
          currentState.change_type,
          currentState.skipped_phases,
          params.phase,
        );
        if (advanced) {
          // Only advance if the next phase's gate would pass.
          // This prevents advancing past phases that need approval
          // (e.g., staying at plan until design.md is approved).
          const nextGate = checkPhaseGate(
            advanced,
            featureDir,
            currentState.change_type,
            currentState.skipped_phases,
          );
          if (nextGate.canAdvance) {
            nextPhase = advanced;
          }
        }
      }
    }

    const updatedState: FlowState = {
      ...currentState,
      budget: {
        total_tokens: currentState.budget.total_tokens + usage.tokens,
        total_cost_usd: currentState.budget.total_cost_usd + usage.cost,
      },
      last_updated: new Date().toISOString(),
      current_phase: nextPhase,
      ...(params.wave !== undefined ? { current_wave: params.wave } : {}),
    };
    writeStateFile(featureDir, updatedState);
  } catch {
    /* budget loss acceptable */
  }

  if (writeCheckpointOnSuccess) {
    try {
      const snapshot = results.map((r) => `${r.agent}: exit=${r.exitCode}`).join(', ');
      writeCheckpoint(featureDir, params.phase, params.wave ?? null, snapshot);
    } catch {
      /* checkpoint loss acceptable */
    }
  }

  for (const r of results) {
    if (r.exitCode === 0) {
      try {
        markTaskComplete(featureDir, r.task);
      } catch {
        /* non-fatal */
      }
    }
  }

  try {
    const agentNames = results.map((r) => r.agent).join(', ') || 'unknown';
    appendProgressLog(featureDir, params.phase, `Dispatched ${agentNames}`);
  } catch {
    /* log loss acceptable */
  }
}

/**
 * Marks a task as complete in tasks.md by replacing '- [ ] <id>' with '- [x] <id>'.
 * No-ops silently when the task ID cannot be extracted, the file doesn't exist,
 * or the pattern is not found.
 */
function markTaskComplete(featureDir: string, taskString: string): void {
  const taskIdMatch = taskString.match(/\btask-\d+\.\d+\b/i);
  if (!taskIdMatch) return;
  const taskId = taskIdMatch[0];

  const tasksPath = path.join(featureDir, 'tasks.md');
  if (!fs.existsSync(tasksPath)) return;

  const content = fs.readFileSync(tasksPath, 'utf8') as string;
  const replacePattern = new RegExp(`- \\[ \\] ${taskId}\\b`);
  if (!replacePattern.test(content)) return;

  const updated = content.replace(replacePattern, `- [x] ${taskId}`);
  fs.writeFileSync(tasksPath, updated, 'utf8');
}

function errorResult(message: string, params: DispatchParams): DispatchResult {
  const mode: 'single' | 'parallel' | 'chain' = params.parallel
    ? 'parallel'
    : params.chain
      ? 'chain'
      : 'single';

  return {
    content: [{ type: 'text', text: `Error: ${message}` }],
    details: {
      mode,
      phase: params.phase,
      feature: params.feature,
      results: [],
    },
    isError: true,
  };
}

function buildContent(results: SingleAgentResult[]): Array<{ type: 'text'; text: string }> {
  return results.map((r) => ({
    type: 'text' as const,
    text:
      getFinalOutput(r.messages) || `[Agent '${r.agent}' completed with exit code ${r.exitCode}]`,
  }));
}
