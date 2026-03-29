/**
 * Integration test — runs the real executor with a fake manager
 * that simulates agent completions. Validates phase transitions,
 * handoff passing, token accumulation, and state persistence.
 */

import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { executeCurrentPhase } from "./executor.js";
import { createWorkflowState } from "./pipeline.js";
import { readEvents, readState } from "./store.js";
import type { WorkflowDefinition } from "./types.js";

// ── Fake Manager ─────────────────────────────────────────────────────

function createFakeManager(responses: Record<string, { result: string; toolUses?: number; turnCount?: number }>) {
  const spawned: { type: string; prompt: string }[] = [];
  let nextId = 0;

  return {
    manager: {
      spawn({ type, prompt }: { pi: unknown; ctx: unknown; type: string; prompt: string; options: unknown }) {
        spawned.push({ type, prompt });
        const id = `agent-${++nextId}`;
        return id;
      },
      getRecord(id: string) {
        const idx = Number.parseInt(id.replace("agent-", "")) - 1;
        const entry = spawned[idx];
        const response = entry ? responses[entry.type] : undefined;
        return {
          id,
          promise: Promise.resolve(),
          status: "completed" as const,
          result: response?.result ?? "No output.",
          toolUses: response?.toolUses ?? 0,
          turnCount: response?.turnCount ?? 1,
          startedAt: Date.now() - 1000,
          completedAt: Date.now(),
          session: { getSessionStats: () => ({ tokens: { total: 500, input: 200, output: 300 } }) },
        };
      },
      abort() {
        return true;
      },
      listAgents() {
        return Array.from({ length: nextId }, (_, i) => {
          const id = `agent-${i + 1}`;
          const entry = spawned[i];
          const response = entry ? responses[entry.type] : undefined;
          return {
            id,
            completedAt: Date.now(),
            session: { getSessionStats: () => ({ tokens: { total: 500, input: 200, output: 300 } }) },
            result: response?.result ?? "No output.",
            toolUses: response?.toolUses ?? 0,
            turnCount: response?.turnCount ?? 1,
          };
        });
      },
    } as any,
    getSpawned: () => spawned,
  };
}

// ── Test Setup ───────────────────────────────────────────────────────

const mockPi = {} as any;
const mockCtx = { cwd: "", model: undefined, modelRegistry: {}, sessionManager: {} } as any;

let testDir: string;

beforeEach(() => {
  testDir = join(tmpdir(), `pi-flow-test-${Date.now()}`);
  mkdirSync(testDir, { recursive: true });
  mockCtx.cwd = testDir;
});

afterEach(() => {
  rmSync(testDir, { recursive: true, force: true });
});

// ── Definitions ──────────────────────────────────────────────────────

const twoPhaseWorkflow: WorkflowDefinition = {
  name: "test-two-phase",
  description: "Scout then build",
  triggers: [],
  phases: [
    { name: "scout", role: "scout", mode: "single", description: "Explore" },
    { name: "build", role: "builder", mode: "single", description: "Implement", contextFrom: "scout" },
  ],
  config: { tokenLimit: 100_000 },
  orchestratorInstructions: "Test instructions",
  source: "builtin",
};

const reviewWorkflow: WorkflowDefinition = {
  name: "test-review",
  description: "Build then review",
  triggers: [],
  phases: [
    { name: "build", role: "builder", mode: "single", description: "Implement" },
    {
      name: "review",
      role: "reviewer",
      mode: "review-loop",
      description: "Review",
      fixRole: "builder",
      maxCycles: 2,
      contextFrom: "build",
    },
  ],
  config: { tokenLimit: 100_000 },
  orchestratorInstructions: "",
  source: "builtin",
};

const gateWorkflow: WorkflowDefinition = {
  name: "test-gate",
  description: "Scout then gate then build",
  triggers: [],
  phases: [
    { name: "scout", role: "scout", mode: "single", description: "Explore" },
    { name: "approve", mode: "gate", description: "Approve" },
    { name: "build", role: "builder", mode: "single", description: "Implement" },
  ],
  config: { tokenLimit: 100_000 },
  orchestratorInstructions: "",
  source: "builtin",
};

// ── Tests ────────────────────────────────────────────────────────────

describe("workflow integration", () => {
  it("executes a two-phase workflow end-to-end", async () => {
    const { manager, getSpawned } = createFakeManager({
      scout: { result: "Found 3 files to fix", toolUses: 5, turnCount: 4 },
      builder: { result: "Fixed all files", toolUses: 12, turnCount: 8 },
    });

    const state = createWorkflowState({
      definition: twoPhaseWorkflow,
      description: "Fix bugs",
      workflowId: "flow-test",
    });
    const { mkdirSync: mk } = await import("node:fs");
    mk(join(testDir, ".pi/flow/flow-test/handoffs"), { recursive: true });

    const outcome = await executeCurrentPhase({
      definition: twoPhaseWorkflow,
      state,
      cwd: testDir,
      workflowId: "flow-test",
      pi: mockPi,
      ctx: mockCtx,
      manager,
    });

    // Both phases completed → workflow finished
    expect(outcome.type).toBe("workflow-complete");
    if (outcome.type === "workflow-complete") {
      expect(outcome.exitReason).toBe("clean");
    }

    // Two agents were spawned (scout + builder)
    const spawned = getSpawned();
    expect(spawned).toHaveLength(2);
    expect(spawned[0]?.type).toBe("scout");
    expect(spawned[1]?.type).toBe("builder");

    // Builder received scout's handoff context
    expect(spawned[1]?.prompt).toContain("Found 3 files to fix");

    // State persisted correctly
    const finalState = readState({ cwd: testDir, workflowId: "flow-test" });
    expect(finalState?.exitReason).toBe("clean");
    expect(finalState?.completedAt).toBeDefined();
    expect(finalState?.phases.scout?.status).toBe("complete");
    expect(finalState?.phases.build?.status).toBe("complete");

    // Tokens accumulated
    expect(finalState?.tokens.total).toBeGreaterThan(0);

    // Events logged
    const events = readEvents(testDir, "flow-test");
    const types = events.map((e) => e.type);
    expect(types).toContain("phase_start");
    expect(types).toContain("phase_complete");
    expect(types).toContain("handoff_written");
    expect(types).toContain("workflow_complete");
  });

  it("pauses at gate phase and returns gate-waiting", async () => {
    const { manager } = createFakeManager({
      scout: { result: "Analysis complete" },
    });

    const state = createWorkflowState({ definition: gateWorkflow, description: "Test gate", workflowId: "flow-gate" });
    mkdirSync(join(testDir, ".pi/flow/flow-gate/handoffs"), { recursive: true });

    const outcome = await executeCurrentPhase({
      definition: gateWorkflow,
      state,
      cwd: testDir,
      workflowId: "flow-gate",
      pi: mockPi,
      ctx: mockCtx,
      manager,
    });

    expect(outcome.type).toBe("gate-waiting");

    // Scout completed, gate is waiting
    const savedState = readState({ cwd: testDir, workflowId: "flow-gate" });
    expect(savedState?.phases.scout?.status).toBe("complete");
    expect(savedState?.phases.approve?.status).toBe("gate-waiting");
  });

  it("review loop cycles until SHIP verdict", async () => {
    const { manager, getSpawned } = createFakeManager({
      builder: { result: "Implementation done", toolUses: 10, turnCount: 6 },
      reviewer: { result: "## Verdict: SHIP\n\nLooks great.", toolUses: 3, turnCount: 2 },
    });

    const state = createWorkflowState({
      definition: reviewWorkflow,
      description: "Test review",
      workflowId: "flow-review",
    });
    mkdirSync(join(testDir, ".pi/flow/flow-review/handoffs"), { recursive: true });

    const outcome = await executeCurrentPhase({
      definition: reviewWorkflow,
      state,
      cwd: testDir,
      workflowId: "flow-review",
      pi: mockPi,
      ctx: mockCtx,
      manager,
    });

    expect(outcome.type).toBe("workflow-complete");

    // Builder + reviewer spawned (SHIP on first review → no fix cycle)
    const spawned = getSpawned();
    expect(spawned).toHaveLength(2);
    expect(spawned[0]?.type).toBe("builder");
    expect(spawned[1]?.type).toBe("reviewer");

    // Review verdict event logged
    const events = readEvents(testDir, "flow-review");
    const verdictEvents = events.filter((e) => e.type === "review_verdict");
    expect(verdictEvents).toHaveLength(1);
    if (verdictEvents[0]?.type === "review_verdict") {
      expect(verdictEvents[0].verdict).toBe("SHIP");
    }
  });

  it("aborts when signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();

    const { manager } = createFakeManager({});
    const state = createWorkflowState({
      definition: twoPhaseWorkflow,
      description: "Test abort",
      workflowId: "flow-abort",
    });
    mkdirSync(join(testDir, ".pi/flow/flow-abort/handoffs"), { recursive: true });

    const outcome = await executeCurrentPhase({
      definition: twoPhaseWorkflow,
      state,
      cwd: testDir,
      workflowId: "flow-abort",
      pi: mockPi,
      ctx: mockCtx,
      manager,
      signal: controller.signal,
    });

    expect(outcome.type).toBe("workflow-complete");
    if (outcome.type === "workflow-complete") {
      expect(outcome.exitReason).toBe("user_abort");
    }
  });
});
