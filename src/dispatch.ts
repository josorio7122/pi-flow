import * as path from 'node:path';
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
import { readStateFile, writeDispatchLog, writeStateFile, ensureFeatureDir, appendProgressLog } from './state.js';

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
 * Sums input+output tokens and cost across an array of SingleAgentResults.
 */
export function aggregateUsage(results: SingleAgentResult[]): { tokens: number; cost: number } {
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
  config: FlowConfig,
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

  const result = await spawnAgentWithRetry(
    cwd,
    agent,
    task,
    variableMap,
    signal,
    onAgentUpdate,
  );

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
  config: FlowConfig,
  phase: Phase,
  feature: string,
  signal?: AbortSignal,
  onUpdate?: OnUpdateCallback,
): Promise<SingleAgentResult[]> {
  const buildDetailsForUpdate = makeDetails('chain', phase, feature);
  const results: SingleAgentResult[] = [];
  const flowDir = path.join(cwd, '.flow');

  for (let i = 0; i < steps.length; i++) {
    const { agent, task: rawTask } = steps[i];

    // Replace all {previous} occurrences with the prior agent's final output
    const previousOutput =
      results.length > 0 ? getFinalOutput(results[results.length - 1].messages) : '';
    const task = rawTask.replace(/\{previous\}/g, previousOutput);

    const onAgentUpdate = onUpdate
      ? (result: SingleAgentResult) => {
          const currentResults = [...results, result];
          onUpdate({
            content: currentResults.map((r) => ({
              type: 'text' as const,
              text: getFinalOutput(r.messages),
            })),
            details: buildDetailsForUpdate(currentResults),
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

    // Write dispatch log for this step
    writeDispatchLog(flowDir, feature, {
      agent: agent.name,
      task,
      phase,
      step: i + 1,
      exitCode: result.exitCode,
      usage: result.usage,
    });

    results.push(result);

    // Emit accumulated update after each step (covers cases where the
    // agent's own callback was never invoked, e.g. in tests)
    if (onUpdate) {
      onUpdate({
        content: results.map((r) => ({
          type: 'text' as const,
          text: getFinalOutput(r.messages),
        })),
        details: buildDetailsForUpdate([...results]),
      });
    }

    // Stop chain on error
    if (result.exitCode !== 0) {
      break;
    }
  }

  return results;
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

    // b. Discover agents
    const agents = discoverAgents(extensionDir, cwd);

    // e. Build variable map (done once, shared across all agents)
    const featureDir = path.join(cwd, '.flow', 'features', params.feature);

    // State initialization: create state.md if this is the first dispatch for this feature
    let currentState = readStateFile(featureDir);
    if (!currentState) {
      ensureFeatureDir(cwd, params.feature);
      currentState = {
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
      writeStateFile(featureDir, currentState);
    }

    const variableMap = buildVariableMap(cwd, featureDir, currentState);

    // f. Route to the appropriate executor

    if (params.parallel) {
      // c. Find and validate all parallel agents
      const agentTasks: Array<{ agent: FlowAgentConfig; task: string }> = [];
      for (const { agent: agentName, task } of params.parallel) {
        const agent = findAgent(agents, agentName);
        if (!agent) {
          return errorResult(
            `Agent '${agentName}' not found. Available agents: ${agents.map((a) => a.name).join(', ')}`,
            params,
          );
        }
        const phaseCheck = validateAgentPhase(agent, params.phase);
        if (!phaseCheck.allowed) {
          return errorResult(`Phase validation failed: ${phaseCheck.reason}`, params);
        }
        agentTasks.push({ agent, task });
      }

      const results = await executeParallel(
        agentTasks,
        cwd,
        variableMap,
        config,
        params.phase,
        params.feature,
        signal,
        onUpdate,
      );
      const details = makeDetails('parallel', params.phase, params.feature)(results);

      accumulateBudget(featureDir, currentState, results, params);

      return {
        content: buildContent(results),
        details,
      };
    }

    if (params.chain) {
      // c. Find and validate all chain agents
      const steps: Array<{ agent: FlowAgentConfig; task: string }> = [];
      for (const { agent: agentName, task } of params.chain) {
        const agent = findAgent(agents, agentName);
        if (!agent) {
          return errorResult(
            `Agent '${agentName}' not found. Available agents: ${agents.map((a) => a.name).join(', ')}`,
            params,
          );
        }
        const phaseCheck = validateAgentPhase(agent, params.phase);
        if (!phaseCheck.allowed) {
          return errorResult(`Phase validation failed: ${phaseCheck.reason}`, params);
        }
        steps.push({ agent, task });
      }

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

      accumulateBudget(featureDir, currentState, results, params);

      return {
        content: buildContent(results),
        details,
      };
    }

    // Single mode
    const agentName = params.agent;
    const task = params.task;

    if (!agentName || !task) {
      return errorResult(
        'dispatch_flow requires one of: agent+task, parallel, or chain.',
        params,
      );
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

    accumulateBudget(featureDir, currentState, [result], params);

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
 * Updates state budget from execution results, writes state file, and appends
 * a progress log entry. All failures are swallowed — budget/log loss is acceptable.
 */
function accumulateBudget(
  featureDir: string,
  currentState: FlowState,
  results: SingleAgentResult[],
  params: DispatchParams,
): void {
  try {
    const usage = aggregateUsage(results);
    const updatedState: FlowState = {
      ...currentState,
      budget: {
        total_tokens: currentState.budget.total_tokens + usage.tokens,
        total_cost_usd: currentState.budget.total_cost_usd + usage.cost,
      },
      last_updated: new Date().toISOString(),
      current_phase: params.phase,
      ...(params.wave !== undefined ? { current_wave: params.wave } : {}),
    };
    writeStateFile(featureDir, updatedState);
  } catch { /* budget loss acceptable */ }

  try {
    const agentNames = results.map((r) => r.agent).join(', ') || 'unknown';
    appendProgressLog(featureDir, params.phase, `Dispatched ${agentNames}`);
  } catch { /* log loss acceptable */ }
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

function buildContent(
  results: SingleAgentResult[],
): Array<{ type: 'text'; text: string }> {
  return results.map((r) => ({
    type: 'text' as const,
    text:
      getFinalOutput(r.messages) ||
      `[Agent '${r.agent}' completed with exit code ${r.exitCode}]`,
  }));
}
