import type { FlowAgentConfig, FlowState } from './types.js';

// ─── Constants ────────────────────────────────────────────────────────────────

const AGENT_TABLE_CAP = 15;
const DESCRIPTION_MAX_CHARS = 80;

// ─── Private helpers ──────────────────────────────────────────────────────────

function buildAgentTable(agents: FlowAgentConfig[]): string {
  const capped = agents.slice(0, AGENT_TABLE_CAP);
  const overflow = agents.length - capped.length;

  const rows = capped.map((a) => {
    const firstSentence = a.description.split('.')[0].trim();
    const role = firstSentence.slice(0, DESCRIPTION_MAX_CHARS);
    const phases = a.phases.join(', ');
    return `| ${a.name} | ${phases} | ${role} |`;
  });

  const header = '| Agent | Phases | Role |';
  const separator = '|-------|--------|------|';
  const lines = [header, separator, ...rows];

  if (overflow > 0) {
    lines.push(`...and ${overflow} more`);
  }

  return lines.join('\n');
}

// ─── buildCoordinatorPrompt ───────────────────────────────────────────────────

/**
 * Builds the coordinator system prompt (~200-300 tokens).
 * Pure function — no filesystem access.
 */
export function buildCoordinatorPrompt(
  agents: FlowAgentConfig[],
  activeFeature: { state: FlowState; featureDir: string } | null,
): string {
  const agentTable = buildAgentTable(agents);

  let prompt = `## Coordinator

You coordinate work via \`dispatch_flow\`. You NEVER write code directly — only \`.flow/\` files.

### Modes

**Just Answer** — Non-code questions → answer directly.
**Understand** — Code questions → dispatch scouts → synthesize.
**Implement** — Code changes → full pipeline: intent → spec → analyze → plan → execute → review → ship.

### Agents

${agentTable}

### Phase Pipeline

intent → spec → analyze → plan → execute → review → ship
Gates: spec.md (approval) → analysis.md → design.md (approval) + tasks.md → sentinel clear → review.md (PASSED)

### .flow/ Directory

\`.flow/features/<feature>/\` — state.md, spec.md, design.md, tasks.md, sentinel-log.md
\`.flow/memory/\` — decisions.md, patterns.md, lessons.md (cross-feature)

### Dispatch Rules

Tasks must include: objective, boundaries, context, output expectations.
Write task files to \`.flow/features/<feature>/\` before dispatching agents.`;

  if (activeFeature !== null) {
    const { state } = activeFeature;
    const { feature, current_phase, current_wave, wave_count, sentinel } = state;

    let activeLine = `### ⚠️ Active: "${feature}" — Phase: ${current_phase}`;

    if (current_wave !== null && wave_count !== null) {
      activeLine += ` [wave ${current_wave}/${wave_count}]`;
    }

    if (sentinel.open_halts > 0) {
      activeLine += ` [${sentinel.open_halts} HALT]`;
    }

    prompt += `\n\n${activeLine}`;
  }

  return prompt;
}

// ─── buildNudgeMessage ────────────────────────────────────────────────────────

/**
 * Returns a one-liner nudge reminding the coordinator of the active workflow.
 */
export function buildNudgeMessage(state: FlowState): string {
  return `⚠️ Feature "${state.feature}" in progress — phase: ${state.current_phase}. Continue working. Read .flow/features/${state.feature}/state.md for next steps.`;
}
