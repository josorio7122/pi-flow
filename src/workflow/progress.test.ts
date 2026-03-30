import { describe, expect, it } from "vitest";
import { createWorkflowState } from "./pipeline.js";
import { buildStatusText, formatDuration, getStatusIcon } from "./progress.js";
import type { WorkflowDefinition } from "./types.js";

describe("formatDuration", () => {
  it("formats seconds", () => {
    expect(formatDuration(5_000)).toBe("5s");
  });

  it("formats minutes and seconds", () => {
    expect(formatDuration(125_000)).toBe("2m05s");
  });

  it("handles zero", () => {
    expect(formatDuration(0)).toBe("0s");
  });
});

describe("getStatusIcon", () => {
  it("returns icons for known statuses", () => {
    expect(getStatusIcon("complete")).toBe("\u2713");
    expect(getStatusIcon("running")).toBe("\u25CF");
    expect(getStatusIcon("pending")).toBe("\u25CB");
    expect(getStatusIcon("failed")).toBe("\u2717");
    expect(getStatusIcon("skipped")).toBe("\u2014");
    expect(getStatusIcon("gate-waiting")).toBe("\u23F8");
  });

  it("returns ? for unknown status", () => {
    expect(getStatusIcon("bogus")).toBe("?");
  });
});

const testDef: WorkflowDefinition = {
  name: "fix",
  description: "fix workflow",
  triggers: [],
  phases: [
    { name: "scout", role: "scout", mode: "single", description: "scan" },
    { name: "build", role: "builder", mode: "single", description: "build" },
    { name: "review", role: "reviewer", mode: "review-loop", description: "review" },
  ],
  config: { tokenLimit: 100_000 },
  orchestratorInstructions: "",
  source: "builtin",
};

describe("buildStatusText", () => {
  it("shows phase and token count", () => {
    const state = createWorkflowState({ definition: testDef, description: "test", workflowId: "f-1" });
    state.currentPhase = "build";
    state.tokens.total = 15_000;
    const text = buildStatusText(state);
    expect(text).toContain("build");
    expect(text).toContain("15.0K");
  });
});
