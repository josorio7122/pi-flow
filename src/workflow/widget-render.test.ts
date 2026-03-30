/**
 * End-to-end test: verify the workflow widget render shows live agent data.
 * Simulates the exact data flow: activity tracker → agentActivity map → render.
 */

import { describe, expect, it } from "vitest";
import { createActivityTracker } from "../extension/activity-tracker.js";
import type { AgentRecord } from "../types.js";
import type { AgentActivity } from "../ui/formatters.js";
import { renderRunningLine } from "../ui/widget-render.js";

function mockTheme() {
  return {
    fg: (_color: string, text: string) => text,
    bold: (text: string) => text,
  } as any;
}

function mockAgent(id: string): AgentRecord {
  return {
    id,
    type: "scout",
    description: "test scout",
    status: "running",
    toolUses: 0,
    turnCount: 0,
    startedAt: Date.now(),
  };
}

describe("workflow widget render with live activity", () => {
  it("shows tool name + args when tool is active", () => {
    const agentActivity = new Map<string, AgentActivity>();
    const { state, callbacks } = createActivityTracker();
    const agentId = "agent-1";
    agentActivity.set(agentId, state);

    // Simulate tool start with args
    callbacks.onToolActivity({ type: "start", toolName: "read", args: { path: "/foo/bar/payments/models.py" } });

    const activity = agentActivity.get(agentId)!;
    expect(activity.activeTools.size).toBe(1);
    expect(activity.lastToolArgs.size).toBe(1);

    // Verify renderRunningLine uses it
    const pair = renderRunningLine({
      agent: mockAgent(agentId),
      theme: mockTheme(),
      activity,
      config: { displayName: "scout" },
      frame: "⠋",
    });
    expect(pair.activity).toContain("reading");
    expect(pair.activity).toContain("payments/models.py");
  });

  it("shows thinking when no tools and no response text", () => {
    const { state } = createActivityTracker();

    const pair = renderRunningLine({
      agent: mockAgent("agent-2"),
      theme: mockTheme(),
      activity: state,
      config: { displayName: "scout" },
      frame: "⠋",
    });
    expect(pair.activity).toContain("thinking");
  });

  it("accumulates responseText across multiple deltas", () => {
    const { state, callbacks } = createActivityTracker();

    callbacks.onTextDelta("Line 1\n", "Line 1\n");
    callbacks.onTextDelta("Line 2\n", "Line 1\nLine 2\n");
    callbacks.onTextDelta("Line 3\n", "Line 1\nLine 2\nLine 3\n");
    callbacks.onTextDelta("Line 4\n", "Line 1\nLine 2\nLine 3\nLine 4\n");
    callbacks.onTextDelta("Line 5\n", "Line 1\nLine 2\nLine 3\nLine 4\nLine 5\n");
    callbacks.onTextDelta("Line 6\n", "Line 1\nLine 2\nLine 3\nLine 4\nLine 5\nLine 6\n");

    expect(state.responseText).toContain("Line 1");
    expect(state.responseText).toContain("Line 6");

    // Last 5 lines
    const tail = state.responseText.trim().split("\n").slice(-5);
    expect(tail).toHaveLength(5);
    expect(tail[0]).toBe("Line 2");
    expect(tail[4]).toBe("Line 6");
  });

  it("responseText survives tool execution cycles", () => {
    const { state, callbacks } = createActivityTracker();

    // Turn 1: text then tools
    callbacks.onTextDelta("Starting exploration\n", "Starting exploration\n");
    callbacks.onToolActivity({ type: "start", toolName: "read", args: { path: "/foo.py" } });
    callbacks.onToolActivity({ type: "end", toolName: "read" });

    // Between turns — responseText has text, toolLog has tool entries
    expect(state.responseText).toContain("Starting exploration");
    expect(state.toolLog).toHaveLength(1);
    expect(state.toolLog[0]?.tool).toContain("read:");
    expect(state.activeTools.size).toBe(0);

    // Turn 2: more text
    callbacks.onTextDelta("Found payment models\n", "Found payment models\n");

    // responseText accumulates everything
    expect(state.responseText).toContain("Starting exploration");
    expect(state.responseText).toContain("Found payment models");
  });

  it("bash tool shows truncated command", () => {
    const { state, callbacks } = createActivityTracker();

    callbacks.onToolActivity({
      type: "start",
      toolName: "bash",
      args: { command: "cd /Users/josorio/Code/website && grep -r 'stripe' payments/" },
    });

    const activity = state;
    const pair = renderRunningLine({
      agent: mockAgent("agent-3"),
      theme: mockTheme(),
      activity,
      config: { displayName: "scout" },
      frame: "⠋",
    });
    expect(pair.activity).toContain("running");
    expect(pair.activity).toContain("grep");
  });

  it("grep tool shows pattern", () => {
    const { state, callbacks } = createActivityTracker();

    callbacks.onToolActivity({
      type: "start",
      toolName: "grep",
      args: { pattern: "payment_intent" },
    });

    const pair = renderRunningLine({
      agent: mockAgent("agent-4"),
      theme: mockTheme(),
      activity: state,
      config: { displayName: "scout" },
      frame: "⠋",
    });
    expect(pair.activity).toContain("searching");
    expect(pair.activity).toContain("payment_intent");
  });

  it("responseText visible in activity map via shared reference", () => {
    const sharedMap = new Map<string, AgentActivity>();
    const { state, callbacks } = createActivityTracker();
    const agentId = "agent-shared";

    sharedMap.set(agentId, state);

    callbacks.onTextDelta("First line\n", "First line\n");
    callbacks.onTextDelta("Second line\n", "First line\nSecond line\n");
    callbacks.onTextDelta("Third line\n", "First line\nSecond line\nThird line\n");

    const activityFromMap = sharedMap.get(agentId);
    expect(activityFromMap).toBeDefined();
    expect(activityFromMap!.responseText).toContain("First line");
    expect(activityFromMap!.responseText).toContain("Third line");

    const tail = activityFromMap!.responseText.trim().split("\n").slice(-5);
    expect(tail).toHaveLength(3);

    callbacks.onToolActivity({ type: "start", toolName: "read", args: { path: "/test.py" } });
    expect(activityFromMap!.activeTools.size).toBe(1);
    expect(activityFromMap!.lastToolArgs.size).toBe(1);
  });
});
