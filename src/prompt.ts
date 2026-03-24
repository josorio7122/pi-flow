import type { FlowAgentConfig, FlowState } from './types.js';
import {
  getEffectivePipeline,
  isTerminalPhase,
  phaseRequiresApproval,
} from './transitions.js';
import { getApprovalFrontmatterExample } from './templates.js';

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

You orchestrate work by dispatching agents via \`dispatch_flow\`. You NEVER use Read, Write, Edit, or Bash tools directly. Every phase is delegated to the appropriate agent.

### Delegation Rules

1. **To understand code** → dispatch scout(s) in parallel. Never read codebase files yourself.
2. **To write/change code** → dispatch builder(s). Never write or edit code yourself.
3. **To write artifacts** → agents write their own artifacts. Never write .flow/ artifact files yourself.
4. **state.md** is managed automatically by the dispatch system. Never write state.md.
5. **Tasks must include**: objective, boundaries, context, output expectations.

### Modes

**Just Answer** — Non-code questions → answer directly.
**Understand** — Code questions → dispatch scouts → synthesize.
**Implement** — Code changes → full pipeline per change type (see below).

### Agents

${agentTable}

### Phase Pipeline & Skip Paths

After each successful dispatch, state.md auto-advances to the next phase.
Dispatch the current phase immediately unless a gate requires human approval.

| Change Type | Pipeline |
|-------------|----------|
| feature | intent → spec → analyze → plan → execute → review → ship |
| refactor | intent → analyze → plan → execute → review → ship |
| hotfix | intent → analyze → plan → execute → review → ship |
| docs | intent → plan → execute → ship |
| config | intent → analyze → plan → execute → ship |
| research | intent → analyze |

Plan (design.md + tasks.md) is always required when execute is present.

### Agent Artifact Ownership

Each agent writes its own artifacts. The coordinator NEVER writes these files.

| Phase | Agent | Writes |
|-------|-------|--------|
| intent | clarifier | brief.md |
| spec | clarifier | spec.md (approved: false) |
| analyze | scout(s) | analysis.md |
| plan | strategist | design.md (approved: false) |
| plan | planner | tasks.md (full checklist) |
| execute | builder | code changes + updates tasks.md (checks off done) |
| review | reviewer | review.md (verdict: PASSED or FAILED) |
| ship | shipper | MR/push |

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
NEVER self-approve. NEVER write \`approved: true\` without the user explicitly approving.
This is the ONLY .flow/ write the coordinator ever does.

### Dispatch Rules

Dispatch the current phase agent with a well-structured task description.
After each dispatch, the system auto-advances to the next phase on success.
Keep dispatching until you reach a gate that needs human approval or the pipeline is complete.`;

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
      const needsApproval = phaseRequiresApproval(current_phase);
      activeLine += `\nAction: dispatch ${current_phase} phase.`;
      if (needsApproval) {
        activeLine += ' Gate requires human approval — present the artifact and ask.';
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

  const needsApproval = phaseRequiresApproval(current_phase);
  const approvalHint = needsApproval
    ? ' Gate requires human approval — present the artifact and ask.'
    : '';

  return `⚠️ Feature "${feature}" — dispatch ${current_phase} phase.${approvalHint}`;
}
