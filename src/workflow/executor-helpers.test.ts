import { describe, expect, it } from "vitest";
import { buildInterruptedContext } from "./executor-helpers.js";
import type { AgentHandoff, WorkflowState } from "./types.js";

function makeState(phaseStatus: string, attempt = 1): WorkflowState {
  return {
    id: "flow-1",
    type: "fix",
    description: "test",
    definitionName: "fix",
    currentPhase: "build",
    phases: { build: { phase: "build", status: phaseStatus as WorkflowState["phases"][string]["status"], attempt } },
    reviewCycle: 0,
    maxReviewCycles: 3,
    tokens: { total: 0, byPhase: {}, limit: 100000, limitReached: false },
    activeAgents: [],
    completedAgents: [],
    countedAgentIds: [],
    startedAt: Date.now(),
  };
}

const HANDOFF: AgentHandoff = {
  agentId: "a1",
  role: "builder",
  phase: "build",
  summary: "partial work",
  findings: "Modified auth.ts",
  filesAnalyzed: [],
  filesModified: ["src/auth.ts"],
  toolsUsed: 5,
  turnsUsed: 3,
  duration: 10000,
  timestamp: Date.now(),
};

describe("buildInterruptedContext", () => {
  it("returns undefined for a fresh phase (pending)", () => {
    const result = buildInterruptedContext({
      state: makeState("pending"),
      phaseName: "build",
      role: "builder",
      handoffs: [],
    });
    expect(result).toBeUndefined();
  });

  it("returns undefined for a completed phase", () => {
    const result = buildInterruptedContext({
      state: makeState("complete"),
      phaseName: "build",
      role: "builder",
      handoffs: [],
    });
    expect(result).toBeUndefined();
  });

  it("returns continuation prompt for an interrupted phase (still running)", () => {
    const result = buildInterruptedContext({
      state: makeState("running"),
      phaseName: "build",
      role: "builder",
      handoffs: [],
    });
    expect(result).toBeDefined();
    expect(result).toContain("Continuation");
    expect(result).toContain("builder");
    expect(result).toContain("interrupted");
  });

  it("includes previous handoff context when available", () => {
    const result = buildInterruptedContext({
      state: makeState("running"),
      phaseName: "build",
      role: "builder",
      handoffs: [HANDOFF],
    });
    expect(result).toContain("src/auth.ts");
    expect(result).toContain("partial work");
  });

  it("uses the latest handoff for the phase", () => {
    const older: AgentHandoff = { ...HANDOFF, summary: "old attempt" };
    const newer: AgentHandoff = { ...HANDOFF, summary: "recent attempt" };
    const result = buildInterruptedContext({
      state: makeState("running"),
      phaseName: "build",
      role: "builder",
      handoffs: [older, newer],
    });
    expect(result).toContain("recent attempt");
  });

  it("increments attempt number from phase result", () => {
    const result = buildInterruptedContext({
      state: makeState("running", 2),
      phaseName: "build",
      role: "builder",
      handoffs: [],
    });
    expect(result).toContain("Attempt 3");
  });
});
