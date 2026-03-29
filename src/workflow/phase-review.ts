/**
 * Review-loop phase — reviewer → parseVerdict → fix → repeat.
 */

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import type { AgentManager } from "../agents/manager.js";
import { detectStuckIssues } from "./pipeline.js";
import { buildFixPrompt, buildReviewPrompt } from "./prompt-builder.js";
import { writeHandoff } from "./store.js";
import type {
  AgentHandoff,
  PhaseDefinition,
  ReviewIssue,
  WorkflowDefinition,
  WorkflowEvent,
  WorkflowState,
} from "./types.js";
import { parseVerdict } from "./verdict.js";

export interface ReviewOutcome {
  type: "complete" | "stuck" | "max_cycles" | "escalate";
  finalVerdict?: string | undefined;
}

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
}): Promise<ReviewOutcome> {
  const maxCycles = phase.maxCycles ?? 3;
  const reviewerRole = phase.role ?? "reviewer";
  const fixRole = phase.fixRole ?? "builder";
  const issueHistory: ReviewIssue[][] = [];

  emitEvent({ type: "phase_start", phase: phase.name, ts: Date.now() });

  let currentHandoff = targetHandoff;

  for (let cycle = 0; cycle < maxCycles; cycle++) {
    state.reviewCycle = cycle + 1;

    // Spawn reviewer
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
      filesAnalyzed: [],
      filesModified: [],
      toolsUsed: reviewRecord.toolUses,
      turnsUsed: 0,
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

    writeHandoff(cwd, workflowId, reviewHandoff);
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

    // Spawn fixer
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
      filesAnalyzed: [],
      filesModified: [],
      toolsUsed: fixRecord.toolUses,
      turnsUsed: 0,
      duration: fixDuration,
      timestamp: Date.now(),
    };

    writeHandoff(cwd, workflowId, currentHandoff);
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
