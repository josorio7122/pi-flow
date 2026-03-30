/**
 * Integration test — runs the executor with a fake manager.
 * Tests the new orchestrator-driven model: one execute call per phase.
 */

import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { executeSinglePhase } from "./executor.js";
import { createWorkflowState } from "./pipeline.js";
import type { WorkflowDefinition } from "./types.js";

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
        const idx = Number.parseInt(id.replace("agent-", ""), 10) - 1;
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
          session: { getSessionStats: () => ({ tokens: { total: 500 } }) },
        };
      },
      abort: () => true,
      listAgents: () => [],
    } as any,
    getSpawned: () => spawned,
  };
}

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

const twoPhaseWorkflow: WorkflowDefinition = {
  name: "test-two-phase",
  description: "Scout then build",
  triggers: [],
  phases: [
    { name: "scout", role: "scout", mode: "single", description: "Explore" },
    { name: "build", role: "builder", mode: "single", description: "Implement", contextFrom: "scout" },
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

describe("workflow integration — orchestrator-driven", () => {
  it("executes one phase per call", async () => {
    const { manager, getSpawned } = createFakeManager({
      scout: { result: "Found 3 files", toolUses: 5, turnCount: 4 },
    });

    const state = createWorkflowState({ definition: twoPhaseWorkflow, description: "Fix bugs", workflowId: "flow-1" });
    mkdirSync(join(testDir, ".pi/flow/flow-1/handoffs"), { recursive: true });

    const outcome = await executeSinglePhase({
      definition: twoPhaseWorkflow,
      state,
      cwd: testDir,
      workflowId: "flow-1",
      pi: mockPi,
      ctx: mockCtx,
      manager,
      tasks: ["Explore the codebase"],
    });

    expect(outcome.type).toBe("phase-complete");
    expect(getSpawned()).toHaveLength(1);
    expect(state.currentPhase).toBe("build"); // Advanced to next
  });

  it("returns workflow-complete on last phase", async () => {
    const { manager } = createFakeManager({
      scout: { result: "Found files" },
      builder: { result: "Fixed all" },
    });

    const state = createWorkflowState({ definition: twoPhaseWorkflow, description: "Fix", workflowId: "flow-2" });
    mkdirSync(join(testDir, ".pi/flow/flow-2/handoffs"), { recursive: true });

    // Phase 1: scout
    await executeSinglePhase({
      definition: twoPhaseWorkflow,
      state,
      cwd: testDir,
      workflowId: "flow-2",
      pi: mockPi,
      ctx: mockCtx,
      manager,
      tasks: ["Scout"],
    });

    // Phase 2: build (last phase)
    const outcome = await executeSinglePhase({
      definition: twoPhaseWorkflow,
      state,
      cwd: testDir,
      workflowId: "flow-2",
      pi: mockPi,
      ctx: mockCtx,
      manager,
      tasks: ["Build it"],
    });

    expect(outcome.type).toBe("workflow-complete");
    if (outcome.type === "workflow-complete") expect(outcome.exitReason).toBe("clean");
  });

  it("returns gate-waiting at gate phase", async () => {
    const { manager } = createFakeManager({
      scout: { result: "Analysis complete" },
    });

    const state = createWorkflowState({ definition: gateWorkflow, description: "Test gate", workflowId: "flow-3" });
    mkdirSync(join(testDir, ".pi/flow/flow-3/handoffs"), { recursive: true });

    // Phase 1: scout
    await executeSinglePhase({
      definition: gateWorkflow,
      state,
      cwd: testDir,
      workflowId: "flow-3",
      pi: mockPi,
      ctx: mockCtx,
      manager,
      tasks: ["Scout"],
    });

    // Phase 2: gate — should return immediately
    const outcome = await executeSinglePhase({
      definition: gateWorkflow,
      state,
      cwd: testDir,
      workflowId: "flow-3",
      pi: mockPi,
      ctx: mockCtx,
      manager,
    });

    expect(outcome.type).toBe("gate-waiting");
  });

  it("aborts when signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const { manager } = createFakeManager({});

    const state = createWorkflowState({ definition: twoPhaseWorkflow, description: "Abort", workflowId: "flow-4" });
    mkdirSync(join(testDir, ".pi/flow/flow-4/handoffs"), { recursive: true });

    const outcome = await executeSinglePhase({
      definition: twoPhaseWorkflow,
      state,
      cwd: testDir,
      workflowId: "flow-4",
      pi: mockPi,
      ctx: mockCtx,
      manager,
      signal: controller.signal,
    });

    expect(outcome.type).toBe("workflow-complete");
    if (outcome.type === "workflow-complete") expect(outcome.exitReason).toBe("user_abort");
  });

  it("spawns multiple agents when given multiple tasks", async () => {
    const { manager, getSpawned } = createFakeManager({
      scout: { result: "Found stuff" },
    });

    const state = createWorkflowState({ definition: twoPhaseWorkflow, description: "Parallel", workflowId: "flow-5" });
    mkdirSync(join(testDir, ".pi/flow/flow-5/handoffs"), { recursive: true });

    await executeSinglePhase({
      definition: twoPhaseWorkflow,
      state,
      cwd: testDir,
      workflowId: "flow-5",
      pi: mockPi,
      ctx: mockCtx,
      manager,
      tasks: ["Map data model", "Map API endpoints", "Map frontend"],
    });

    expect(getSpawned()).toHaveLength(3);
  });
});
