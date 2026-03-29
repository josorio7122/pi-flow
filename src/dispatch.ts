import * as path from 'node:path';

import type {
  FlowAgentConfig,
  FlowDispatchDetails,
  FlowState,
  SingleAgentResult,
  DispatchParams,
  DispatchResult,
} from './types.js';
import { loadConfig } from './config.js';
import { discoverAgents, buildVariableMap } from './agents.js';
import type { ExtensionContext } from '@mariozechner/pi-coding-agent';
import { runAgent } from './runner.js';
import { mapWithConcurrencyLimit, getFinalOutput, emptyResult } from './result-utils.js';
import {
  readStateFile,
  writeDispatchLog,
  writeStateFile,
  ensureFeatureDir,
  appendProgressLog,
  writeCheckpoint,
  writeFinding,
  writeSessionDispatchLog,
} from './state.js';
import { writeArtifact } from './artifacts.js';

// ─── Public types ─────────────────────────────────────────────────────────────

export type OnUpdateCallback = (partial: DispatchResult) => void;

// ─── Feature-requiring agents ─────────────────────────────────────────────────

/** Agents that produce feature-scoped artifacts and require a bound feature. */
const FEATURE_REQUIRED_AGENTS = new Set([
  'builder',
  'test-writer',
  'doc-writer',
  'planner',
  'reviewer',
]);

/**
 * Returns true when the given agent name requires an active feature to dispatch.
 * Scout and probe can run featureless (ad-hoc investigation).
 */
export function requiresFeature(agentName: string): boolean {
  return FEATURE_REQUIRED_AGENTS.has(agentName);
}

// ─── Pure helpers (exported for testing) ──────────────────────────────────────

export function findAgent(agents: FlowAgentConfig[], name: string): FlowAgentConfig | null {
  return agents.find((a) => a.name === name) ?? null;
}

export function resolveAgentTasks(
  items: Array<{ agent: string; task: string }>,
  agents: FlowAgentConfig[],
): { resolved: Array<{ agent: FlowAgentConfig; task: string }> } | { error: string } {
  const resolved: Array<{ agent: FlowAgentConfig; task: string }> = [];
  for (const { agent: agentName, task } of items) {
    const agent = findAgent(agents, agentName);
    if (!agent) {
      return {
        error: `Agent '${agentName}' not found. Available: ${agents.map((a) => a.name).join(', ')}`,
      };
    }
    resolved.push({ agent, task });
  }
  return { resolved };
}

export function makeDetails(
  mode: 'single' | 'parallel' | 'chain',
  feature: string,
): (results: SingleAgentResult[]) => FlowDispatchDetails {
  return (results) => ({ mode, feature, results });
}

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
  feature: string | undefined,
  sessionDir: string | undefined,
  ctx?: ExtensionContext,
  signal?: AbortSignal,
  onUpdate?: OnUpdateCallback,
): Promise<SingleAgentResult> {
  const featureLabel = feature ?? 'ad-hoc';
  const buildDetailsForUpdate = makeDetails('single', featureLabel);

  if (onUpdate) {
    onUpdate({
      content: [{ type: 'text', text: '' }],
      details: buildDetailsForUpdate([emptyResult(agent, task)]),
    });
  }

  const result = await runAgent({
    ctx: ctx as ExtensionContext,
    agent,
    task,
    variableMap,
    signal,
  });

  // Session-scoped dispatch log
  if (sessionDir) {
    writeSessionDispatchLog(sessionDir, {
      agent: agent.name,
      task,
      feature: feature ?? null,
      exitCode: result.exitCode,
      usage: result.usage,
    });
  }

  // Feature-scoped dispatch log (legacy, for feature audit trail)
  if (feature) {
    const flowDir = path.join(cwd, '.flow');
    writeDispatchLog(flowDir, feature, {
      agent: agent.name,
      task,
      exitCode: result.exitCode,
      usage: result.usage,
    });
  }

  return result;
}

async function executeParallel(
  agentTasks: Array<{ agent: FlowAgentConfig; task: string }>,
  cwd: string,
  variableMap: Record<string, string>,
  maxWorkers: number,
  feature: string | undefined,
  sessionDir: string | undefined,
  ctx?: ExtensionContext,
  signal?: AbortSignal,
  onUpdate?: OnUpdateCallback,
): Promise<SingleAgentResult[]> {
  const featureLabel = feature ?? 'ad-hoc';
  const buildDetailsForUpdate = makeDetails('parallel', featureLabel);

  const results: SingleAgentResult[] = agentTasks.map(({ agent, task }) =>
    emptyResult(agent, task),
  );

  if (onUpdate) {
    onUpdate({
      content: results.map((r) => ({ type: 'text' as const, text: getFinalOutput(r.messages) })),
      details: buildDetailsForUpdate([...results]),
    });
  }

  await mapWithConcurrencyLimit(agentTasks, maxWorkers, async ({ agent, task }, index) => {
    const result = await runAgent({
      ctx: ctx as ExtensionContext,
      agent,
      task,
      variableMap,
      signal,
    });
    results[index] = result;

    if (sessionDir) {
      writeSessionDispatchLog(sessionDir, {
        agent: agent.name,
        task,
        feature: feature ?? null,
        exitCode: result.exitCode,
        usage: result.usage,
      });
    }

    if (feature) {
      const flowDir = path.join(cwd, '.flow');
      writeDispatchLog(flowDir, feature, {
        agent: agent.name,
        task,
        exitCode: result.exitCode,
        usage: result.usage,
      });
    }

    return result;
  });

  return results;
}

async function executeChain(
  steps: Array<{ agent: FlowAgentConfig; task: string }>,
  cwd: string,
  variableMap: Record<string, string>,
  feature: string | undefined,
  sessionDir: string | undefined,
  ctx?: ExtensionContext,
  signal?: AbortSignal,
  onUpdate?: OnUpdateCallback,
): Promise<SingleAgentResult[]> {
  const featureLabel = feature ?? 'ad-hoc';
  const buildDetailsForUpdate = makeDetails('chain', featureLabel);

  const allResults: SingleAgentResult[] = steps.map(({ agent, task: rawTask }) =>
    emptyResult(agent, rawTask),
  );

  if (onUpdate) {
    onUpdate({
      content: allResults.map((r) => ({ type: 'text' as const, text: getFinalOutput(r.messages) })),
      details: buildDetailsForUpdate([...allResults]),
    });
  }

  const completedResults: SingleAgentResult[] = [];

  for (let i = 0; i < steps.length; i++) {
    const { agent, task: rawTask } = steps[i];

    const previousOutput =
      completedResults.length > 0
        ? getFinalOutput(completedResults[completedResults.length - 1].messages)
        : '';
    const task = rawTask.replace(/\{previous\}/g, previousOutput);

    const result = await runAgent({
      ctx: ctx as ExtensionContext,
      agent,
      task,
      variableMap,
      signal,
    });
    allResults[i] = result;
    completedResults.push(result);

    if (sessionDir) {
      writeSessionDispatchLog(sessionDir, {
        agent: agent.name,
        task,
        step: i + 1,
        feature: feature ?? null,
        exitCode: result.exitCode,
        usage: result.usage,
      });
    }

    if (feature) {
      const flowDir = path.join(cwd, '.flow');
      writeDispatchLog(flowDir, feature, {
        agent: agent.name,
        task,
        step: i + 1,
        exitCode: result.exitCode,
        usage: result.usage,
      });
    }

    if (onUpdate) {
      onUpdate({
        content: allResults.map((r) => ({
          type: 'text' as const,
          text: getFinalOutput(r.messages),
        })),
        details: buildDetailsForUpdate([...allResults]),
      });
    }

    if (result.exitCode !== 0) {
      return allResults.slice(0, i + 1);
    }
  }

  return allResults;
}

// ─── State helpers ────────────────────────────────────────────────────────────

function initializeState(
  cwd: string,
  feature: string,
): { featureDir: string; state: FlowState } | null {
  const featureDir = path.join(cwd, '.flow', 'features', feature);
  const existing = readStateFile(featureDir);
  if (existing) return { featureDir, state: existing };

  try {
    ensureFeatureDir(cwd, feature);
    const fresh: FlowState = {
      feature,
      started_at: new Date().toISOString(),
      last_updated: new Date().toISOString(),
      budget: { total_tokens: 0, total_cost_usd: 0 },
    };
    writeStateFile(featureDir, fresh);
    return { featureDir, state: fresh };
  } catch {
    return null;
  }
}

function updateBudget(
  featureDir: string,
  currentState: FlowState | null,
  results: SingleAgentResult[],
): void {
  if (!currentState) return;
  try {
    const usage = sumBudget(results);
    const updatedState: FlowState = {
      ...currentState,
      budget: {
        total_tokens: currentState.budget.total_tokens + usage.tokens,
        total_cost_usd: currentState.budget.total_cost_usd + usage.cost,
      },
      last_updated: new Date().toISOString(),
    };
    writeStateFile(featureDir, updatedState);
  } catch {
    /* budget loss acceptable */
  }

  try {
    const logEntries = results
      .filter((r) => r.exitCode !== -1)
      .map((r) => `${r.agent}: exit=${r.exitCode}`)
      .join(', ');
    appendProgressLog(featureDir, `dispatch: ${logEntries}`);
  } catch {
    /* log loss acceptable */
  }

  try {
    writeCheckpoint(featureDir, results);
  } catch {
    /* checkpoint loss acceptable */
  }
}

// ─── Artifact write-back ──────────────────────────────────────────────────────

function writeArtifactsAndFindings(
  featureDir: string | undefined,
  sessionDir: string | undefined,
  agents: FlowAgentConfig[],
  results: SingleAgentResult[],
  resolvedTasks: Array<{ agent: FlowAgentConfig; task: string }>,
): void {
  for (let i = 0; i < results.length; i++) {
    const result = results[i];
    if (result.exitCode !== 0) continue;
    const agent = resolvedTasks[i]?.agent ?? agents.find((a) => a.name === result.agent);
    if (!agent) continue;
    const output = getFinalOutput(result.messages);
    if (!output) continue;

    // Session-scoped findings (scout/probe output always saved per-session)
    if (sessionDir) {
      try {
        writeFinding(sessionDir, agent.name, result.task, output);
      } catch {
        /* finding write failure is non-fatal */
      }
    }

    // Feature-scoped artifacts (only when feature is bound)
    if (featureDir) {
      try {
        writeArtifact(featureDir, agent, output, result.task);
      } catch {
        /* artifact write failure is non-fatal */
      }
    }
  }
}

// ─── Build content for LLM ───────────────────────────────────────────────────

function buildContent(results: SingleAgentResult[]): Array<{ type: 'text'; text: string }> {
  return results.map((r) => ({
    type: 'text' as const,
    text: getFinalOutput(r.messages),
  }));
}

function errorResult(message: string, params: DispatchParams): DispatchResult {
  return {
    content: [{ type: 'text', text: `Error: ${message}` }],
    details: {
      mode: params.parallel ? 'parallel' : params.chain ? 'chain' : 'single',
      feature: params.feature ?? 'unknown',
      results: [],
    },
    isError: true,
  };
}

// ─── Public entry point ───────────────────────────────────────────────────────

export async function executeDispatch(
  params: DispatchParams,
  cwd: string,
  extensionDir: string,
  ctx: ExtensionContext | undefined,
  signal?: AbortSignal,
  onUpdate?: OnUpdateCallback,
): Promise<DispatchResult> {
  try {
    // Validate exactly one mode
    const hasParallel = (params.parallel?.length ?? 0) > 0;
    const hasChain = (params.chain?.length ?? 0) > 0;
    const hasSingle = Boolean(params.agent && params.task);
    const modeCount = Number(hasParallel) + Number(hasChain) + Number(hasSingle);

    if (modeCount !== 1) {
      return errorResult(
        'Specify exactly one mode: agent+task (single), parallel array, or chain array.',
        params,
      );
    }

    // Feature enforcement: check if any dispatched agent requires a feature
    const feature = params.feature;
    const sessionDir = params.sessionDir;
    const agentNames = collectAgentNames(params);

    for (const name of agentNames) {
      if (requiresFeature(name) && !feature) {
        return errorResult(
          `Agent '${name}' requires an active feature. ` +
            `Provide a feature name: dispatch_flow({ feature: "my-feature", ... })`,
          params,
        );
      }
    }

    const config = loadConfig(cwd);

    // Initialize feature state only when feature is provided
    let featureDir: string | undefined;
    let currentState: FlowState | null = null;
    if (feature) {
      const init = initializeState(cwd, feature);
      featureDir = init?.featureDir;
      currentState = init?.state ?? null;
    }

    const agents = discoverAgents(extensionDir, cwd);
    // Use feature dir for variable map when available, fall back to a temp-like path
    const variableDir = featureDir ?? path.join(cwd, '.flow', 'sessions', 'ad-hoc');
    const variableMap = buildVariableMap(cwd, variableDir);
    const featureLabel = feature ?? 'ad-hoc';

    if (hasParallel) {
      const resolved = resolveAgentTasks(params.parallel!, agents);
      if ('error' in resolved) return errorResult(resolved.error, params);

      const results = await executeParallel(
        resolved.resolved,
        cwd,
        variableMap,
        config.concurrency.max_workers,
        feature,
        sessionDir,
        ctx,
        signal,
        onUpdate,
      );
      const details = makeDetails('parallel', featureLabel)(results);
      if (featureDir) updateBudget(featureDir, currentState, results);
      writeArtifactsAndFindings(featureDir, sessionDir, agents, results, resolved.resolved);
      return { content: buildContent(results), details };
    }

    if (hasChain) {
      const resolved = resolveAgentTasks(params.chain!, agents);
      if ('error' in resolved) return errorResult(resolved.error, params);

      const results = await executeChain(
        resolved.resolved,
        cwd,
        variableMap,
        feature,
        sessionDir,
        ctx,
        signal,
        onUpdate,
      );
      const details = makeDetails('chain', featureLabel)(results);
      if (featureDir) updateBudget(featureDir, currentState, results);
      writeArtifactsAndFindings(featureDir, sessionDir, agents, results, resolved.resolved);
      return { content: buildContent(results), details };
    }

    // Single mode (guaranteed by modeCount check above)
    const agent = findAgent(agents, params.agent!);
    if (!agent) {
      return errorResult(
        `Agent '${params.agent}' not found. Available: ${agents.map((a) => a.name).join(', ')}`,
        params,
      );
    }

    const task = params.task!;
    const result = await executeSingle(
      agent,
      task,
      cwd,
      variableMap,
      feature,
      sessionDir,
      ctx,
      signal,
      onUpdate,
    );
    const details = makeDetails('single', featureLabel)([result]);
    if (featureDir) updateBudget(featureDir, currentState, [result]);
    writeArtifactsAndFindings(featureDir, sessionDir, agents, [result], [{ agent, task }]);
    return { content: buildContent([result]), details };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return errorResult(message, params);
  }
}

/**
 * Extracts all agent names from dispatch params (single, parallel, or chain).
 */
function collectAgentNames(params: DispatchParams): string[] {
  if (params.agent) return [params.agent];
  if (params.parallel) return params.parallel.map((p) => p.agent);
  if (params.chain) return params.chain.map((c) => c.agent);
  return [];
}
