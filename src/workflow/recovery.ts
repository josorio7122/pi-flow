/**
 * Crash recovery, stalled detection, and smart restart prompts.
 *
 * - findStalled / formatStalledMessage: adapted from pi-planner executor/stalled.ts
 * - buildContinuationPrompt: adapted from pi-coordination coordinate/auto-continue.ts
 * - isRecoverableExit: copied from pi-coordination coordinate/auto-continue.ts
 */

import type { ActiveAgent, AgentHandoff } from "./types.js";

// ── Stalled Detection ────────────────────────────────────────────────

export function findStalled({
  agents,
  timeoutMs,
  now = Date.now(),
}: {
  agents: readonly ActiveAgent[];
  timeoutMs: number;
  now?: number;
}) {
  return agents.filter((a) => now - a.startedAt > timeoutMs);
}

export function formatStalledMessage(agent: ActiveAgent) {
  const elapsed = Math.round((Date.now() - agent.startedAt) / 60_000);
  return `Agent ${agent.agentId} (${agent.role}) in phase "${agent.phase}" has been running for ${elapsed}m`;
}

// ── Recoverable Exit ────────────���────────────────────────────────────

const NON_RECOVERABLE_CODES = new Set([0, 139, 143]);

export function isRecoverableExit(exitCode: number) {
  return !NON_RECOVERABLE_CODES.has(exitCode);
}

// ── Continuation Prompt ──────────���────────────────────────────���──────

export function buildContinuationPrompt({
  role,
  attemptNumber,
  exitReason,
  previousHandoff,
}: {
  role: string;
  attemptNumber: number;
  exitReason: string;
  previousHandoff?: AgentHandoff | undefined;
}) {
  const sections: string[] = [];

  sections.push(`## Continuation — ${role} (Attempt ${attemptNumber})`);
  sections.push("");
  sections.push(`Exit reason: ${exitReason}`);
  sections.push("");

  if (previousHandoff) {
    sections.push("### Previous Attempt");
    sections.push(`Summary: ${previousHandoff.summary}`);
    sections.push("");

    if (previousHandoff.filesModified.length > 0) {
      sections.push("### Files Already Modified (verify before redoing)");
      for (const f of previousHandoff.filesModified) {
        sections.push(`- ${f}`);
      }
      sections.push("");
    }

    if (previousHandoff.findings) {
      sections.push("### Context from Previous Attempt");
      sections.push(previousHandoff.findings);
      sections.push("");
    }
  }

  sections.push("### Instructions");
  sections.push("1. Verify any existing changes are valid before redoing work");
  sections.push("2. Don't redo work that's already complete");
  sections.push("3. Focus on fixing the issue that caused the previous failure");
  sections.push("");

  return sections.join("\n");
}
