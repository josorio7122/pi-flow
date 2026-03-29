/**
 * Review-loop phase — reviewer → parseVerdict → fix → repeat.
 */

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import type { AgentManager } from "../agents/manager.js";
import { trackAgentComplete, trackAgentStart } from "./executor-helpers.js";
import { detectStuckIssues } from "./pipeline.js";
import { buildFixPrompt, buildReviewPrompt } from "./prompt-builder.js";
import { writeHandoff, writeState } from "./store.js";
import type {
  AgentHandoff,
  PhaseDefinition,
  ReviewIssue,
  WorkflowDefinition,
  WorkflowEvent,
  WorkflowState,
} from "./types.js";
import { parseVerdict } from "./verdict.js";

export async function executeReviewLoop({
  phase,
  definition,
  state,
  targetHandoff,
  cwd,
  workflowId,
  pi,
  ctx,
  manager,
  emitEvent,
}: {
  phase: PhaseDefinition;
  definition: WorkflowDefinition;
  state: WorkflowState;
  targetHandoff: AgentHandoff;
  cwd: string;
  workflowId: string;
  pi: ExtensionAPI;
  ctx: ExtensionContext;
  manager: AgentManager;
  emitEvent: (event: WorkflowEvent) => void;
}) {
  const maxCycles = phase.maxCycles ?? 3;
  const reviewerRole = phase.role ?? "reviewer";
  const fixRole = phase.fixRole ?? "builder";
  const issueHistory: ReviewIssue[][] = [];

  emitEvent({ type: "phase_start", phase: phase.name, ts: Date.now() });

  let currentHandoff = targetHandoff;

  for (let cycle = 0; cycle < maxCycles; cycle++) {
    state.reviewCycle = cycle + 1;

    // Spawn reviewer — track as active
    trackAgentStart({ state, agentId: `review-${cycle}`, role: reviewerRole, phase: phase.name });
    writeState({ cwd, workflowId, state });

    const reviewPrompt = buildReviewPrompt({
      phase,
      definition,
      state,
      targetHandoff: currentHandoff,
      reviewCycle: cycle,
    });
    const reviewRecord = await manager.spawnAndWait({
      pi,
      ctx,
      type: reviewerRole,
      prompt: reviewPrompt,
      options: { description: `${definition.name}: review (cycle ${cycle + 1})` },
    });

    const review = parseVerdict(reviewRecord.result ?? "");
    const reviewDuration = (reviewRecord.completedAt ?? Date.now()) - reviewRecord.startedAt;

    const reviewHandoff: AgentHandoff = {
      agentId: reviewRecord.id,
      role: reviewerRole,
      phase: phase.name,
      summary: review.summary,
      findings: reviewRecord.result ?? "",
      toolsUsed: reviewRecord.toolUses,
      turnsUsed: reviewRecord.turnCount,
      verdict: review.verdict,
      issues: review.issues.map((desc) => ({
        file: "",
        severity: "warning" as const,
        category: "review",
        description: desc,
      })),
      duration: reviewDuration,
      timestamp: Date.now(),
    };

    const reviewHandoffFile = writeHandoff({ cwd, workflowId, handoff: reviewHandoff });
    trackAgentComplete({
      state,
      agentId: reviewRecord.id,
      role: reviewerRole,
      phase: phase.name,
      handoffFile: reviewHandoffFile,
      duration: reviewDuration,
      exitStatus: reviewRecord.status === "error" ? "error" : "completed",
      error: reviewRecord.error,
    });
    // Remove placeholder
    state.activeAgents = state.activeAgents.filter((a) => a.agentId !== `review-${cycle}`);
    writeState({ cwd, workflowId, state });

    emitEvent({
      type: "review_verdict",
      verdict: review.verdict,
      issueCount: review.issues.length,
      cycle: cycle + 1,
      ts: Date.now(),
    });

    if (review.verdict === "SHIP") {
      emitEvent({ type: "phase_complete", phase: phase.name, duration: 0, tokens: 0, ts: Date.now() });
      return { type: "complete", finalVerdict: "SHIP" };
    }

    if (review.verdict === "MAJOR_RETHINK") {
      return { type: "escalate", finalVerdict: "MAJOR_RETHINK" };
    }

    // Stuck detection
    const currentIssues = reviewHandoff.issues ?? [];
    issueHistory.push([...currentIssues]);
    if (detectStuckIssues({ currentIssues: [...currentIssues], reviewHistory: issueHistory, sameIssueLimit: 3 })) {
      return { type: "stuck", finalVerdict: "NEEDS_WORK" };
    }

    // Spawn fixer — track as active
    trackAgentStart({ state, agentId: `fix-${cycle}`, role: fixRole, phase: phase.name });
    writeState({ cwd, workflowId, state });

    const fixPrompt = buildFixPrompt({ definition, state, reviewHandoff });
    const fixRecord = await manager.spawnAndWait({
      pi,
      ctx,
      type: fixRole,
      prompt: fixPrompt,
      options: { description: `${definition.name}: fix (cycle ${cycle + 1})` },
    });

    const fixDuration = (fixRecord.completedAt ?? Date.now()) - fixRecord.startedAt;
    currentHandoff = {
      agentId: fixRecord.id,
      role: fixRole,
      phase: phase.name,
      summary: `Fix attempt ${cycle + 1}`,
      findings: fixRecord.result ?? "",
      toolsUsed: fixRecord.toolUses,
      turnsUsed: fixRecord.turnCount,
      duration: fixDuration,
      timestamp: Date.now(),
    };

    const fixHandoffFile = writeHandoff({ cwd, workflowId, handoff: currentHandoff });
    trackAgentComplete({
      state,
      agentId: fixRecord.id,
      role: fixRole,
      phase: phase.name,
      handoffFile: fixHandoffFile,
      duration: fixDuration,
      exitStatus: "completed",
    });
    // Remove placeholder
    state.activeAgents = state.activeAgents.filter((a) => a.agentId !== `fix-${cycle}`);
    writeState({ cwd, workflowId, state });

    emitEvent({
      type: "agent_complete",
      role: fixRole,
      agentId: fixRecord.id,
      duration: fixDuration,
      toolUses: fixRecord.toolUses,
      exitStatus: "completed",
      ts: Date.now(),
    });
  }

  return { type: "max_cycles", finalVerdict: "NEEDS_WORK" };
}
