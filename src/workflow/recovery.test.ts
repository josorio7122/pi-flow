import { describe, expect, it } from "vitest";
import { buildContinuationPrompt, findStalled, formatStalledMessage } from "./recovery.js";
import type { ActiveAgent, AgentHandoff } from "./types.js";

describe("findStalled", () => {
  const now = Date.now();

  it("returns agents past the timeout", () => {
    const agents: ActiveAgent[] = [
      { agentId: "a1", role: "builder", phase: "build", startedAt: now - 600_000 },
      { agentId: "a2", role: "scout", phase: "scout", startedAt: now - 10_000 },
    ];
    const stalled = findStalled({ agents, timeoutMs: 300_000, now });
    expect(stalled).toHaveLength(1);
    expect(stalled[0]?.agentId).toBe("a1");
  });

  it("returns empty when all agents are within timeout", () => {
    const agents: ActiveAgent[] = [{ agentId: "a1", role: "scout", phase: "scout", startedAt: now - 10_000 }];
    expect(findStalled({ agents, timeoutMs: 300_000, now })).toEqual([]);
  });

  it("returns empty for empty list", () => {
    expect(findStalled({ agents: [], timeoutMs: 300_000, now })).toEqual([]);
  });
});

describe("formatStalledMessage", () => {
  it("formats agent info with elapsed time", () => {
    const agent: ActiveAgent = { agentId: "a1", role: "builder", phase: "build", startedAt: Date.now() - 360_000 };
    const msg = formatStalledMessage(agent);
    expect(msg).toContain("builder");
    expect(msg).toContain("build");
    expect(msg).toContain("6m");
  });
});

describe("buildContinuationPrompt", () => {
  it("includes attempt number and role", () => {
    const prompt = buildContinuationPrompt({ role: "builder", attemptNumber: 2, exitReason: "crashed" });
    expect(prompt).toContain("Attempt 2");
    expect(prompt).toContain("builder");
    expect(prompt).toContain("crashed");
  });

  it("includes previous handoff findings when provided", () => {
    const handoff: AgentHandoff = {
      agentId: "prev",
      role: "builder",
      phase: "build",
      summary: "partially done",
      findings: "modified types.ts",
      filesAnalyzed: [],
      filesModified: ["src/types.ts"],
      toolsUsed: 5,
      turnsUsed: 3,
      duration: 30_000,
      timestamp: Date.now(),
    };
    const prompt = buildContinuationPrompt({
      role: "builder",
      attemptNumber: 2,
      exitReason: "crashed",
      previousHandoff: handoff,
    });
    expect(prompt).toContain("src/types.ts");
    expect(prompt).toContain("partially done");
  });

  it("works without a previous handoff", () => {
    const prompt = buildContinuationPrompt({ role: "builder", attemptNumber: 1, exitReason: "timeout" });
    expect(prompt).toContain("builder");
    expect(prompt).not.toContain("Previous attempt");
  });
});
