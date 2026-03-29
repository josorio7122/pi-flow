import { describe, expect, it } from "vitest";
import { checkTokenLimit, createTokenState, createWorkflowState, detectStuckIssues, updatePhaseStatus } from "./pipeline.js";
import type { PhaseDefinition, ReviewIssue, WorkflowDefinition } from "./types.js";

const fixPhases: PhaseDefinition[] = [
  { name: "scout", role: "scout", mode: "single", description: "scan" },
  { name: "approve", mode: "gate", description: "approve" },
  { name: "build", role: "builder", mode: "single", description: "build" },
  { name: "review", role: "reviewer", mode: "review-loop", description: "review", maxCycles: 3 },
];

const fixDef: WorkflowDefinition = {
  name: "fix",
  description: "fix workflow",
  triggers: [],
  phases: fixPhases,
  config: { tokenLimit: 100_000 },
  orchestratorInstructions: "",
  source: "builtin",
};

function phase(state: ReturnType<typeof createWorkflowState>, name: string) {
  const p = state.phases[name];
  if (!p) throw new Error(`Phase ${name} not found`);
  return p;
}

describe("createWorkflowState", () => {
  it("initializes phases from definition", () => {
    const state = createWorkflowState({ definition: fixDef, description: "remove any", workflowId: "flow-123" });
    expect(state.id).toBe("flow-123");
    expect(state.type).toBe("fix");
    expect(state.description).toBe("remove any");
    expect(state.currentPhase).toBe("scout");
    expect(Object.keys(state.phases)).toEqual(["scout", "approve", "build", "review"]);
    expect(phase(state, "scout").status).toBe("pending");
    expect(phase(state, "scout").attempt).toBe(0);
    expect(state.activeAgents).toEqual([]);
    expect(state.completedAgents).toEqual([]);
  });
});

describe("createTokenState", () => {
  it("initializes with zero totals and given limit", () => {
    const tokens = createTokenState(50_000);
    expect(tokens.total).toBe(0);
    expect(tokens.limit).toBe(50_000);
    expect(tokens.limitReached).toBe(false);
    expect(tokens.byPhase).toEqual({});
  });
});

describe("updatePhaseStatus", () => {
  it("transitions pending to running", () => {
    const state = createWorkflowState({ definition: fixDef, description: "test", workflowId: "f-1" });
    const events: unknown[] = [];
    updatePhaseStatus({ state, phase: "scout", status: "running", onEvent: (e) => events.push(e) });
    expect(phase(state, "scout").status).toBe("running");
    expect(phase(state, "scout").startedAt).toBeGreaterThan(0);
    expect(phase(state, "scout").attempt).toBe(1);
    expect(state.currentPhase).toBe("scout");
    expect(events.length).toBe(1);
    expect(events[0]).toMatchObject({ type: "phase_start", phase: "scout" });
  });

  it("transitions running to complete", () => {
    const state = createWorkflowState({ definition: fixDef, description: "test", workflowId: "f-1" });
    const events: unknown[] = [];
    const onEvent = (e: unknown) => events.push(e);
    updatePhaseStatus({ state, phase: "scout", status: "running", onEvent });
    updatePhaseStatus({ state, phase: "scout", status: "complete", onEvent });
    expect(phase(state, "scout").status).toBe("complete");
    expect(phase(state, "scout").completedAt).toBeGreaterThan(0);
    expect(events.length).toBe(2);
    expect(events[1]).toMatchObject({ type: "phase_complete", phase: "scout" });
  });

  it("transitions running to failed with error", () => {
    const state = createWorkflowState({ definition: fixDef, description: "test", workflowId: "f-1" });
    updatePhaseStatus({ state, phase: "scout", status: "running", onEvent: () => {} });
    updatePhaseStatus({ state, phase: "scout", status: "failed", error: "crashed", onEvent: () => {} });
    expect(phase(state, "scout").status).toBe("failed");
    expect(phase(state, "scout").error).toBe("crashed");
  });
});

describe("checkTokenLimit", () => {
  it("returns false when under limit", () => {
    const tokens = createTokenState(100_000);
    tokens.total = 50_000;
    expect(checkTokenLimit(tokens)).toBe(false);
  });

  it("returns true when at limit", () => {
    const tokens = createTokenState(100_000);
    tokens.total = 100_000;
    expect(checkTokenLimit(tokens)).toBe(true);
    expect(tokens.limitReached).toBe(true);
  });

  it("returns true when over limit", () => {
    const tokens = createTokenState(100_000);
    tokens.total = 150_000;
    expect(checkTokenLimit(tokens)).toBe(true);
  });

  it("returns false when limit is 0 (unlimited)", () => {
    const tokens = createTokenState(0);
    tokens.total = 999_999;
    expect(checkTokenLimit(tokens)).toBe(false);
  });
});

describe("detectStuckIssues", () => {
  const makeIssue = (file: string, desc: string): ReviewIssue => ({
    file,
    description: desc,
    severity: "error",
    category: "bug",
  });

  it("returns false with less than 2 review cycles", () => {
    const current = [makeIssue("a.ts", "issue 1")];
    expect(detectStuckIssues({ currentIssues: current, reviewHistory: [current], sameIssueLimit: 1 })).toBe(false);
  });

  it("returns true when same issues repeat across cycles", () => {
    const issues = [makeIssue("a.ts", "issue 1"), makeIssue("b.ts", "issue 2")];
    const history = [issues, issues];
    expect(detectStuckIssues({ currentIssues: issues, reviewHistory: history, sameIssueLimit: 2 })).toBe(true);
  });

  it("returns false when issues are different", () => {
    const prev = [makeIssue("a.ts", "old issue")];
    const current = [makeIssue("b.ts", "new issue")];
    expect(detectStuckIssues({ currentIssues: current, reviewHistory: [prev, current], sameIssueLimit: 1 })).toBe(
      false,
    );
  });
});
