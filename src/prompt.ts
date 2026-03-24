import type { FlowAgentConfig, FlowState } from './types.js';
import {
  getEffectivePipeline,
  getNextPhase,
  isTerminalPhase,
  phaseRequiresApproval,
} from './transitions.js';
import { getApprovalFrontmatterExample } from './templates.js';

// ─── Constants ────────────────────────────────────────────────────────────────

const AGENT_TABLE_CAP = 15;
const DESCRIPTION_MAX_CHARS = 80;

/** Maps phase → the primary agent name to hint in prompts/nudges. */
const PHASE_TO_AGENT: Record<string, string> = {
  intent: 'clarifier',
  spec: 'clarifier',
  analyze: 'scout(s)',
  plan: 'strategist',
  execute: 'builder',
  review: 'reviewer',
  ship: 'shipper',
};

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
 * Builds the coordinator system prompt.
 * Pure function — no filesystem access.
 */
export function buildCoordinatorPrompt(
  agents: FlowAgentConfig[],
  activeFeature: { state: FlowState; featureDir: string } | null,
): string {
  const agentTable = buildAgentTable(agents);
  const approvalExample = getApprovalFrontmatterExample();

  let prompt = `## Coordinator

You orchestrate work by dispatching agents via \`dispatch_flow\`. Every phase is delegated to the appropriate agent. You do NOT use Read, Write, Edit, or Bash tools — with one exception (see Approval Gates below).

### How to dispatch

Phase and feature are **auto-inferred**. You only need to provide the agent and task:

\`\`\`
dispatch_flow({ agent: "scout", task: "Map the auth module" })
\`\`\`

For parallel scouts:
\`\`\`
dispatch_flow({ parallel: [
  { agent: "scout", task: "Map models" },
  { agent: "scout", task: "Map views" }
]})
\`\`\`

For sequential chain:
\`\`\`
dispatch_flow({ chain: [
  { agent: "scout", task: "Find all endpoints" },
  { agent: "strategist", task: "Design solution based on: {previous}" }
]})
\`\`\`

Only provide \`feature\` when starting a NEW feature (first dispatch).
Never provide \`phase\` — it is auto-inferred from the agent type.

### Delegation Rules

1. **To understand code** → dispatch scout(s). Never read codebase files yourself.
2. **To write/change code** → dispatch builder. Never write or edit code yourself.
3. **To write artifacts** → agents write their own artifacts. Never write .flow/ artifact files yourself.
4. **state.md** is managed automatically. Never write state.md.
5. **Tasks must include**: objective, boundaries, context, output expectations.
6. **The ONLY exception**: after the user explicitly approves spec.md or design.md, you use Edit to write the \`approved: true\` frontmatter. This is the only file write you ever do.

### Modes

**Just Answer** — Non-code questions → answer directly.
**Understand** — Code questions → dispatch scouts → synthesize.
**Implement** — Code changes → full pipeline per change type (see below).

### Agents

${agentTable}

### Workflow

After each successful dispatch, the system auto-advances to the next phase.
Keep dispatching until a gate requires human approval or the pipeline is complete.

| Change Type | Pipeline |
|-------------|----------|
| feature | intent → spec → analyze → plan → execute → review → ship |
| refactor | intent → analyze → plan → execute → review → ship |
| hotfix | intent → analyze → plan → execute → review → ship |
| docs | intent → plan → execute → ship |
| config | intent → analyze → plan → execute → ship |
| research | intent → analyze |

### Agent Artifact Ownership

Each agent writes its own artifacts. The coordinator NEVER writes these files.

| Agent | Writes |
|-------|--------|
| clarifier | brief.md, spec.md (approved: false) |
| scout(s) | analysis.md |
| strategist | design.md (approved: false) |
| planner | tasks.md (full checklist) |
| builder | code changes + updates tasks.md (checks off done) |
| reviewer | review.md (verdict: PASSED or FAILED) |
| shipper | MR/push |

### Human Approval Gates

spec.md and design.md require human approval before the next phase can begin.
When a gate needs approval:
1. Summarize the artifact for the user (from the agent's output — do not Read the file)
2. Ask: "Do you approve this [spec/design]?"
3. Wait for the user's explicit yes
4. Only then write the approved frontmatter using this exact format:

\`\`\`
${approvalExample}
\`\`\`

The \`---\` delimiters are required. The value must be \`true\` (not \`yes\`, not \`1\`).
NEVER self-approve. NEVER write \`approved: true\` without the user explicitly approving.`;

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

    if (isTerminalPhase(state.change_type, state.skipped_phases, current_phase)) {
      activeLine += '\nWorkflow complete — no more phases.';
    } else {
      const agentHint = PHASE_TO_AGENT[current_phase] ?? current_phase;
      activeLine += `\nAction: dispatch ${agentHint} with a task.`;
      const nextP = getNextPhase(state.change_type, state.skipped_phases, current_phase);
      if (nextP && phaseRequiresApproval(nextP)) {
        activeLine += ` Next phase (${nextP}) requires human approval — present the artifact and ask before advancing.`;
      }
    }

    prompt += `\n\n${activeLine}`;
  }

  return prompt;
}

// ─── buildNudgeMessage ────────────────────────────────────────────────────────

/**
 * Returns a nudge message telling the coordinator to dispatch the current phase.
 *
 * After auto-advance, `current_phase` is "the phase that needs to be done next"
 * — NOT "the phase just completed". The nudge directs the coordinator to dispatch
 * that phase. If the current phase is terminal, the feature is complete.
 */
export function buildNudgeMessage(state: FlowState): string {
  const { feature, current_phase, change_type, skipped_phases } = state;

  if (isTerminalPhase(change_type, skipped_phases, current_phase)) {
    return `✅ Feature "${feature}" — all phases complete.`;
  }

  // Phase not in pipeline at all (stale state) — treat as complete
  const pipeline = getEffectivePipeline(change_type, skipped_phases);
  if (!pipeline.includes(current_phase)) {
    return `✅ Feature "${feature}" — all phases complete.`;
  }

  const agentHint = PHASE_TO_AGENT[current_phase] ?? current_phase;
  const nextPhase = getNextPhase(change_type, skipped_phases, current_phase);
  const nextNeedsApproval = nextPhase && phaseRequiresApproval(nextPhase);
  const approvalHint = nextNeedsApproval
    ? ` Next phase (${nextPhase}) requires human approval — present the artifact and ask before advancing.`
    : '';

  return `⚠️ Feature "${feature}" — dispatch ${agentHint} with a task.${approvalHint}`;
}
