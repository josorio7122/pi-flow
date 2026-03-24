import type { FlowAgentConfig, FlowSkillConfig, FlowState } from './types.js';

// ─── Constants ────────────────────────────────────────────────────────────────

const DESCRIPTION_MAX_CHARS = 80;

// ─── buildCoordinatorPrompt ───────────────────────────────────────────────────

export function buildCoordinatorPrompt(
  agents: FlowAgentConfig[],
  skills: FlowSkillConfig[],
  activeFeature: { state: FlowState; featureDir: string } | null,
): string {
  // Agent table
  const agentRows = agents.map((a) => {
    const desc = a.description.split('.')[0].trim().slice(0, DESCRIPTION_MAX_CHARS);
    return `| ${a.name} | ${a.model} | ${desc} |`;
  });
  const agentTable = [
    '| Agent | Model | Role |',
    '|-------|-------|------|',
    ...agentRows,
  ].join('\n');

  // Skills sections
  const skillSections = skills.map((s) => s.body).join('\n\n');

  let prompt = `## Coordinator

You orchestrate development by dispatching specialized agents and
following skills for structured decision-making.

### How to dispatch

\`\`\`
dispatch_flow({ agent: "scout", task: "Map the auth module" })
\`\`\`

Parallel (concurrent scouts):
\`\`\`
dispatch_flow({ parallel: [
  { agent: "scout", task: "Map models" },
  { agent: "scout", task: "Map views" }
]})
\`\`\`

Chain (sequential, {previous} = prior output):
\`\`\`
dispatch_flow({ chain: [
  { agent: "scout", task: "Find all endpoints" },
  { agent: "planner", task: "Create tasks from: {previous}" }
]})
\`\`\`

Only provide \`feature\` when starting a NEW feature (first dispatch).
After that, the active feature is used automatically.

### Rules

- **NEVER** write production code — dispatch builder.
- **NEVER** read large codebases yourself — dispatch scouts.
- You MAY write files inside \`.flow/\` (memory, notes, design docs).
- You MAY run git commands when the user asks to ship.
- You decide the workflow. There are no fixed phases.

### Available Agents

${agentTable}

### Skills

${skillSections}`;

  if (activeFeature) {
    const { state } = activeFeature;
    const cost = state.budget.total_cost_usd.toFixed(2);
    prompt += `\n\n### Active Feature\n\nFeature: "${state.feature}" | Budget: $${cost}`;
  }

  return prompt;
}
