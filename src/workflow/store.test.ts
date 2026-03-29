import { appendFileSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  appendEvent,
  getFlowDir,
  initWorkflowDir,
  listHandoffs,
  readEvents,
  readState,
  writeHandoff,
  writeState,
} from "./store.js";
import type { AgentHandoff, WorkflowEvent, WorkflowState } from "./types.js";

let tmpDir: string;
const WF_ID = "flow-test-001";

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "pi-flow-store-"));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("initWorkflowDir", () => {
  it("creates the directory structure", () => {
    initWorkflowDir(tmpDir, WF_ID);
    const flowDir = getFlowDir(tmpDir, WF_ID);
    expect(existsSync(flowDir)).toBe(true);
    expect(existsSync(join(flowDir, "handoffs"))).toBe(true);
  });
});

describe("state operations", () => {
  it("returns null when state does not exist", () => {
    initWorkflowDir(tmpDir, WF_ID);
    expect(readState({ cwd: tmpDir, workflowId: WF_ID })).toBeNull();
  });

  it("writes and reads state", () => {
    initWorkflowDir(tmpDir, WF_ID);
    const state: WorkflowState = {
      id: WF_ID,
      type: "fix",
      description: "test",
      definitionName: "fix",
      currentPhase: "scout",
      phases: { scout: { phase: "scout", status: "pending", attempt: 0 } },
      reviewCycle: 0,
      maxReviewCycles: 3,
      tokens: { total: 0, byPhase: {}, limit: 100000, limitReached: false },
      activeAgents: [],
      completedAgents: [],
      countedAgentIds: [],
      startedAt: Date.now(),
    };
    writeState({ cwd: tmpDir, workflowId: WF_ID, state: state });
    const loaded = readState({ cwd: tmpDir, workflowId: WF_ID });
    expect(loaded).toEqual(state);
  });

  it("returns null for structurally invalid state JSON", () => {
    initWorkflowDir(tmpDir, WF_ID);
    const statePath = join(getFlowDir(tmpDir, WF_ID), "state.json");
    writeFileSync(statePath, JSON.stringify({ notAState: true }));
    expect(readState({ cwd: tmpDir, workflowId: WF_ID })).toBeNull();
  });
});

describe("handoff operations", () => {
  const handoff: AgentHandoff = {
    agentId: "agent-1",
    role: "scout",
    phase: "scout",
    summary: "Found 3 issues",
    findings: "details...",
    filesAnalyzed: ["a.ts"],
    filesModified: [],
    toolsUsed: 5,
    turnsUsed: 2,
    duration: 10_000,
    timestamp: Date.now(),
  };

  it("writes a handoff and auto-increments numbers", () => {
    initWorkflowDir(tmpDir, WF_ID);
    const file1 = writeHandoff({ cwd: tmpDir, workflowId: WF_ID, handoff: handoff });
    const file2 = writeHandoff({
      cwd: tmpDir,
      workflowId: WF_ID,
      handoff: { ...handoff, role: "builder", phase: "build" },
    });
    expect(file1).toBe("001-scout.json");
    expect(file2).toBe("002-builder.json");
  });

  it("returns empty list when handoff JSON is structurally invalid", () => {
    initWorkflowDir(tmpDir, WF_ID);
    const dir = join(getFlowDir(tmpDir, WF_ID), "handoffs");
    writeFileSync(join(dir, "001-bad.json"), JSON.stringify({ notAHandoff: true }));
    expect(listHandoffs({ cwd: tmpDir, workflowId: WF_ID })).toHaveLength(0);
  });

  it("lists handoffs in order", () => {
    initWorkflowDir(tmpDir, WF_ID);
    writeHandoff({ cwd: tmpDir, workflowId: WF_ID, handoff: handoff });
    writeHandoff({
      cwd: tmpDir,
      workflowId: WF_ID,
      handoff: { ...handoff, role: "builder", phase: "build", summary: "Built it" },
    });
    const all = listHandoffs({ cwd: tmpDir, workflowId: WF_ID });
    expect(all).toHaveLength(2);
    expect(all[0]?.role).toBe("scout");
    expect(all[1]?.role).toBe("builder");
  });
});

describe("event operations", () => {
  it("appends and reads events", () => {
    initWorkflowDir(tmpDir, WF_ID);
    const e1: WorkflowEvent = { type: "workflow_start", workflowType: "fix", description: "test", ts: 1000 };
    const e2: WorkflowEvent = { type: "phase_start", phase: "scout", ts: 1001 };
    appendEvent({ cwd: tmpDir, workflowId: WF_ID, event: e1 });
    appendEvent({ cwd: tmpDir, workflowId: WF_ID, event: e2 });
    const events = readEvents(tmpDir, WF_ID);
    expect(events).toHaveLength(2);
    expect(events[0]?.type).toBe("workflow_start");
    expect(events[1]?.type).toBe("phase_start");
  });

  it("returns empty array when no events", () => {
    initWorkflowDir(tmpDir, WF_ID);
    expect(readEvents(tmpDir, WF_ID)).toEqual([]);
  });

  it("skips malformed JSONL lines", () => {
    initWorkflowDir(tmpDir, WF_ID);
    const e1: WorkflowEvent = { type: "phase_start", phase: "scout", ts: 1001 };
    appendEvent({ cwd: tmpDir, workflowId: WF_ID, event: e1 });
    // Append a corrupt line directly
    const eventsFile = join(getFlowDir(tmpDir, WF_ID), "events.jsonl");
    appendFileSync(eventsFile, "not valid json\n");
    appendFileSync(eventsFile, '{"no_type_field": true}\n');
    const e2: WorkflowEvent = { type: "phase_complete", phase: "scout", duration: 100, tokens: 50, ts: 1002 };
    appendEvent({ cwd: tmpDir, workflowId: WF_ID, event: e2 });
    const events = readEvents(tmpDir, WF_ID);
    expect(events).toHaveLength(2);
    expect(events[0]?.type).toBe("phase_start");
    expect(events[1]?.type).toBe("phase_complete");
  });
});
