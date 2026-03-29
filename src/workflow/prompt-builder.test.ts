import { describe, expect, it } from "vitest";
import { buildFixPrompt, buildPhasePrompt, buildReviewPrompt } from "./prompt-builder.js";
import type { AgentHandoff, PhaseDefinition, WorkflowDefinition, WorkflowState } from "./types.js";

const DEF: WorkflowDefinition = {
  name: "test-flow",
  description: "Test workflow",
  triggers: [],
  phases: [{ name: "scout", role: "scout", mode: "single", description: "Scan codebase" }],
  config: { tokenLimit: 100000 },
  orchestratorInstructions: "Be thorough.",
  source: "builtin",
};

const STATE: WorkflowState = {
  id: "flow-1",
  type: "test-flow",
  description: "Fix the bug",
  definitionName: "test-flow",
  currentPhase: "scout",
  phases: { scout: { phase: "scout", status: "running", attempt: 1 } },
  reviewCycle: 0,
  tokens: { total: 5000, byPhase: {}, limit: 100000, limitReached: false },
  activeAgents: [],
  completedAgents: [],
  countedAgentIds: [],
  startedAt: Date.now(),
};

const HANDOFF: AgentHandoff = {
  agentId: "a1",
  role: "scout",
  phase: "scout",
  summary: "Found 3 files with issues",
  findings: "src/foo.ts has a null check missing",
  filesAnalyzed: ["src/foo.ts", "src/bar.ts"],
  filesModified: [],
  toolsUsed: 5,
  duration: 10000,
  timestamp: Date.now(),
};

describe("buildPhasePrompt", () => {
  it("includes workflow name, task, and phase", () => {
    const phase: PhaseDefinition = { name: "scout", role: "scout", mode: "single", description: "Scan codebase" };
    const prompt = buildPhasePrompt({ phase, definition: DEF, state: STATE });
    expect(prompt).toContain("test-flow");
    expect(prompt).toContain("Fix the bug");
    expect(prompt).toContain("scout");
    expect(prompt).toContain("Be thorough.");
  });

  it("includes previous handoff when provided", () => {
    const phase: PhaseDefinition = { name: "build", role: "builder", mode: "single", description: "" };
    const prompt = buildPhasePrompt({ phase, definition: DEF, state: STATE, previousHandoff: HANDOFF });
    expect(prompt).toContain("Found 3 files");
    expect(prompt).toContain("src/foo.ts");
  });

  it("warns when token budget is low", () => {
    const lowState = { ...STATE, tokens: { ...STATE.tokens, total: 90000 } };
    const phase: PhaseDefinition = { name: "scout", role: "scout", mode: "single", description: "" };
    const prompt = buildPhasePrompt({ phase, definition: DEF, state: lowState });
    expect(prompt).toContain("Budget Warning");
  });
});

describe("buildReviewPrompt", () => {
  it("includes review protocol and cycle count", () => {
    const phase: PhaseDefinition = {
      name: "review",
      role: "reviewer",
      mode: "review-loop",
      description: "",
      maxCycles: 3,
    };
    const prompt = buildReviewPrompt({ phase, definition: DEF, state: STATE, targetHandoff: HANDOFF, reviewCycle: 0 });
    expect(prompt).toContain("Cycle 1/3");
    expect(prompt).toContain("SHIP");
    expect(prompt).toContain("NEEDS_WORK");
    expect(prompt).toContain("MAJOR_RETHINK");
    expect(prompt).toContain("src/foo.ts");
  });
});

describe("buildFixPrompt", () => {
  it("includes issues to fix", () => {
    const reviewHandoff: AgentHandoff = {
      ...HANDOFF,
      role: "reviewer",
      phase: "review",
      issues: [{ file: "src/foo.ts", line: 42, severity: "error", category: "bug", description: "Null check missing" }],
    };
    const prompt = buildFixPrompt({ definition: DEF, state: STATE, reviewHandoff });
    expect(prompt).toContain("[error] src/foo.ts:42");
    expect(prompt).toContain("Null check missing");
  });
});
