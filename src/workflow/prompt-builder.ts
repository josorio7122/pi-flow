/**
 * Build agent prompts from workflow context and previous handoffs.
 * Pure — no I/O, no side effects.
 */

import type { AgentHandoff, PhaseDefinition, WorkflowDefinition, WorkflowState } from "./types.js";

export function buildPhasePrompt({
  phase,
  definition,
  state,
  previousHandoff,
}: {
  phase: PhaseDefinition;
  definition: WorkflowDefinition;
  state: WorkflowState;
  previousHandoff?: AgentHandoff | undefined;
}) {
  const sections: string[] = [];

  sections.push(`# Workflow: ${definition.name}`);
  sections.push(`## Task: ${state.description}`);
  sections.push(`## Phase: ${phase.name} (${phase.mode})`);
  if (phase.description) sections.push(phase.description);

  if (definition.orchestratorInstructions) {
    sections.push(`## Instructions\n${definition.orchestratorInstructions}`);
  }

  if (previousHandoff) {
    sections.push(formatHandoffContext(previousHandoff));
  }

  const remaining = state.tokens.limit - state.tokens.total;
  if (remaining < state.tokens.limit * 0.2) {
    sections.push(`## Budget Warning\nToken budget is low: ${remaining} tokens remaining of ${state.tokens.limit}.`);
  }

  return sections.join("\n\n");
}

function formatHandoffContext(handoff: AgentHandoff) {
  const parts = [`## Context from ${handoff.role} (${handoff.phase} phase)`];
  if (handoff.summary) parts.push(`### Summary\n${handoff.summary}`);
  if (handoff.findings) parts.push(`### Findings\n${handoff.findings}`);
  if (handoff.filesAnalyzed.length > 0) parts.push(`### Files Analyzed\n${handoff.filesAnalyzed.join("\n")}`);
  if (handoff.filesModified.length > 0) parts.push(`### Files Modified\n${handoff.filesModified.join("\n")}`);
  if (handoff.issues && handoff.issues.length > 0) {
    parts.push(
      `### Issues Found\n${handoff.issues.map((i) => `- [${i.severity}] ${i.file}${i.line ? `:${i.line}` : ""}: ${i.description}`).join("\n")}`,
    );
  }
  return parts.join("\n\n");
}

export function buildReviewPrompt({
  phase,
  definition,
  state,
  targetHandoff,
  reviewCycle,
}: {
  phase: PhaseDefinition;
  definition: WorkflowDefinition;
  state: WorkflowState;
  targetHandoff: AgentHandoff;
  reviewCycle: number;
}) {
  const sections: string[] = [];

  sections.push(`# Code Review — Cycle ${reviewCycle + 1}/${phase.maxCycles ?? 3}`);
  sections.push(`## Workflow: ${definition.name}`);
  sections.push(`## Task: ${state.description}`);

  sections.push(formatHandoffContext(targetHandoff));

  sections.push(`## Review Protocol
Review the implementation and output your verdict:
- **SHIP** — implementation is correct, tests pass, ready to merge
- **NEEDS_WORK** — specific issues found, list them clearly
- **MAJOR_RETHINK** — fundamental approach is wrong, explain why

Start your response with the verdict on its own line: \`SHIP\`, \`NEEDS_WORK\`, or \`MAJOR_RETHINK\``);

  if (definition.orchestratorInstructions) {
    sections.push(`## Additional Context\n${definition.orchestratorInstructions}`);
  }

  return sections.join("\n\n");
}

export function buildFixPrompt({
  definition,
  state,
  reviewHandoff,
}: {
  definition: WorkflowDefinition;
  state: WorkflowState;
  reviewHandoff: AgentHandoff;
}) {
  const sections: string[] = [];

  sections.push(`# Fix Issues — Review Cycle ${state.reviewCycle}`);
  sections.push(`## Workflow: ${definition.name}`);
  sections.push(`## Task: ${state.description}`);

  if (reviewHandoff.issues && reviewHandoff.issues.length > 0) {
    sections.push(
      `## Issues to Fix\n${reviewHandoff.issues.map((i) => `- [${i.severity}] ${i.file}${i.line ? `:${i.line}` : ""}: ${i.description}${i.suggestedFix ? ` → ${i.suggestedFix}` : ""}`).join("\n")}`,
    );
  }

  if (reviewHandoff.findings) {
    sections.push(`## Reviewer Notes\n${reviewHandoff.findings}`);
  }

  sections.push("Fix all listed issues. Run tests to verify your changes.");

  return sections.join("\n\n");
}
