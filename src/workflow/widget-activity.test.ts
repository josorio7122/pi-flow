/**
 * Test: verify activity tracker callbacks are wired through spawnWithAbort
 * and that agentActivity map gets populated with live data.
 */

import { describe, expect, it, vi } from "vitest";
import { createActivityTracker } from "../extension/activity-tracker.js";

describe("activity tracker for workflow widget", () => {
  it("onStreamUpdate fires on tool activity", () => {
    const onUpdate = vi.fn();
    const { state, callbacks } = createActivityTracker(undefined, onUpdate);

    callbacks.onToolActivity({ type: "start", toolName: "read" });
    expect(onUpdate).toHaveBeenCalledTimes(1);
    expect(state.activeTools.size).toBe(1);

    callbacks.onToolActivity({ type: "end", toolName: "read" });
    expect(onUpdate).toHaveBeenCalledTimes(2);
    expect(state.activeTools.size).toBe(0);
    expect(state.toolUses).toBe(1);
  });

  it("onStreamUpdate fires on text delta", () => {
    const onUpdate = vi.fn();
    const { state, callbacks } = createActivityTracker(undefined, onUpdate);

    callbacks.onTextDelta("Hello", "Hello");
    expect(onUpdate).toHaveBeenCalledTimes(1);
    expect(state.responseText).toBe("Hello");

    callbacks.onTextDelta(" world", "Hello world");
    expect(onUpdate).toHaveBeenCalledTimes(2);
    expect(state.responseText).toBe("Hello world");
  });

  it("onStreamUpdate fires on turn end", () => {
    const onUpdate = vi.fn();
    const { state, callbacks } = createActivityTracker(undefined, onUpdate);

    callbacks.onTurnEnd(2);
    expect(onUpdate).toHaveBeenCalledTimes(1);
    expect(state.turnCount).toBe(2);
  });

  it("activeTools shows current tool during execution", () => {
    const { state, callbacks } = createActivityTracker();

    callbacks.onToolActivity({ type: "start", toolName: "bash" });
    const toolNames = [...state.activeTools.values()];
    expect(toolNames).toContain("bash");

    callbacks.onToolActivity({ type: "end", toolName: "bash" });
    expect(state.activeTools.size).toBe(0);
  });

  it("describeActivity returns tool action when active", async () => {
    const { describeActivity } = await import("../ui/formatters.js");
    const tools = new Map<string, string>();
    tools.set("bash_123", "bash");

    expect(describeActivity(tools)).toBe("running command");
    expect(describeActivity(tools, "stale text")).toBe("running command");

    tools.clear();
    expect(describeActivity(tools, "last line of text")).toBe("last line of text");
    expect(describeActivity(tools)).toBe("thinking…");
  });

  it("callbacks object has all required keys for manager.spawn", () => {
    const { callbacks } = createActivityTracker();
    expect(typeof callbacks.onToolActivity).toBe("function");
    expect(typeof callbacks.onTextDelta).toBe("function");
    expect(typeof callbacks.onTurnEnd).toBe("function");
    expect(typeof callbacks.onSessionCreated).toBe("function");
  });
});
