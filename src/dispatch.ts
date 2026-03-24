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
import { spawnAgentWithRetry, mapWithConcurrencyLimit, getFinalOutput, emptyResult } from './spawn.js';
import {
  readStateFile,
  writeDispatchLog,
  writeStateFile,
  ensureFeatureDir,
  appendProgressLog,
  writeCheckpoint,
} from './state.js';
import { writeArtifact } from './artifacts.js';

// ─── Public types ─────────────────────────────────────────────────────────────

export type OnUpdateCallback = (partial: DispatchResult) => void;

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
  feature: string,
  signal?: AbortSignal,
  onUpdate?: OnUpdateCallback,
): Promise<SingleAgentResult> {
  const buildDetailsForUpdate = makeDetails('single', feature);

  if (onUpdate) {
    onUpdate({
      content: [{ type: 'text', text: '' }],
      details: buildDetailsForUpdate([emptyResult(agent, task)]),
    });
  }

  const onAgentUpdate = onUpdate
    ? (result: SingleAgentResult) => {
        onUpdate({
          content: [{ type: 'text', text: getFinalOutput(result.messages) }],
          details: buildDetailsForUpdate([result]),
        });
      }
    : undefined;

  const result = await spawnAgentWithRetry(cwd, agent, task, variableMap, signal, onAgentUpdate);

  const flowDir = path.join(cwd, '.flow');
  writeDispatchLog(flowDir, feature, {
    agent: agent.name,
    task,
    exitCode: result.exitCode,
    usage: result.usage,
  });

  return result;
}

async function executeParallel(
  agentTasks: Array<{ agent: FlowAgentConfig; task: string }>,
  cwd: string,
  variableMap: Record<string, string>,
  maxWorkers: number,
  feature: string,
  signal?: AbortSignal,
  onUpdate?: OnUpdateCallback,
): Promise<SingleAgentResult[]> {
  const buildDetailsForUpdate = makeDetails('parallel', feature);

  const results: SingleAgentResult[] = agentTasks.map(({ agent, task }) => emptyResult(agent, task));

  if (onUpdate) {
    onUpdate({
      content: results.map((r) => ({ type: 'text' as const, text: getFinalOutput(r.messages) })),
      details: buildDetailsForUpdate([...results]),
    });
  }

  await mapWithConcurrencyLimit(
    agentTasks,
    maxWorkers,
    async ({ agent, task }, index) => {
      const onAgentUpdate = onUpdate
        ? (result: SingleAgentResult) => {
            results[index] = result;
            onUpdate({
              content: results.map((r) => ({ type: 'text' as const, text: getFinalOutput(r.messages) })),
              details: buildDetailsForUpdate([...results]),
            });
          }
        : undefined;

      const result = await spawnAgentWithRetry(cwd, agent, task, variableMap, signal, onAgentUpdate);
      results[index] = result;

      const flowDir = path.join(cwd, '.flow');
      writeDispatchLog(flowDir, feature, {
        agent: agent.name,
        task,
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
  feature: string,
  signal?: AbortSignal,
  onUpdate?: OnUpdateCallback,
): Promise<SingleAgentResult[]> {
  const buildDetailsForUpdate = makeDetails('chain', feature);
  const flowDir = path.join(cwd, '.flow');

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

    const onAgentUpdate = onUpdate
      ? (result: SingleAgentResult) => {
          allResults[i] = result;
          onUpdate({
            content: allResults.map((r) => ({ type: 'text' as const, text: getFinalOutput(r.messages) })),
            details: buildDetailsForUpdate([...allResults]),
          });
        }
      : undefined;

    const result = await spawnAgentWithRetry(cwd, agent, task, variableMap, signal, onAgentUpdate);
    allResults[i] = result;
    completedResults.push(result);

    writeDispatchLog(flowDir, feature, {
      agent: agent.name,
      task,
      step: i + 1,
      exitCode: result.exitCode,
      usage: result.usage,
    });

    if (onUpdate) {
      onUpdate({
        content: allResults.map((r) => ({ type: 'text' as const, text: getFinalOutput(r.messages) })),
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

function initializeState(cwd: string, featureDir: string, feature: string): FlowState | null {
  const existing = readStateFile(featureDir);
  if (existing) return existing;

  try {
    ensureFeatureDir(cwd, feature);
    const fresh: FlowState = {
      feature,
      started_at: new Date().toISOString(),
      last_updated: new Date().toISOString(),
      budget: { total_tokens: 0, total_cost_usd: 0 },
    };
    writeStateFile(featureDir, fresh);
    return fresh;
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

function writeArtifacts(
  featureDir: string,
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
    try {
      writeArtifact(featureDir, agent, output, result.task);
    } catch {
      /* artifact write failure is non-fatal */
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
  signal?: AbortSignal,
  onUpdate?: OnUpdateCallback,
): Promise<DispatchResult> {
  try {
    const config = loadConfig(cwd);
    const feature = params.feature ?? 'default';
    const featureDir = path.join(cwd, '.flow', 'features', feature);
    const currentState = initializeState(cwd, featureDir, feature);
    const agents = discoverAgents(extensionDir, cwd);
    const variableMap = buildVariableMap(cwd, featureDir);

    if (params.parallel) {
      const resolved = resolveAgentTasks(params.parallel, agents);
      if ('error' in resolved) return errorResult(resolved.error, params);

      const results = await executeParallel(
        resolved.resolved, cwd, variableMap, config.concurrency.max_workers, feature, signal, onUpdate,
      );
      const details = makeDetails('parallel', feature)(results);
      updateBudget(featureDir, currentState, results);
      writeArtifacts(featureDir, agents, results, resolved.resolved);
      return { content: buildContent(results), details };
    }

    if (params.chain) {
      const resolved = resolveAgentTasks(params.chain, agents);
      if ('error' in resolved) return errorResult(resolved.error, params);

      const results = await executeChain(
        resolved.resolved, cwd, variableMap, feature, signal, onUpdate,
      );
      const details = makeDetails('chain', feature)(results);
      updateBudget(featureDir, currentState, results);
      writeArtifacts(featureDir, agents, results, resolved.resolved);
      return { content: buildContent(results), details };
    }

    // Single mode
    if (!params.agent || !params.task) {
      return errorResult('dispatch_flow requires one of: agent+task, parallel, or chain.', params);
    }

    const agent = findAgent(agents, params.agent);
    if (!agent) {
      return errorResult(
        `Agent '${params.agent}' not found. Available: ${agents.map((a) => a.name).join(', ')}`,
        params,
      );
    }

    const result = await executeSingle(
      agent, params.task, cwd, variableMap, feature, signal, onUpdate,
    );
    const details = makeDetails('single', feature)([result]);
    updateBudget(featureDir, currentState, [result]);
    writeArtifacts(featureDir, agents, [result], [{ agent, task: params.task }]);
    return { content: buildContent([result]), details };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return errorResult(message, params);
  }
}
