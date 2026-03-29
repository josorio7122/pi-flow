import { describe, expect, it } from "vitest";
import { extractTasksFromHandoff } from "./phase-parallel.js";
import type { AgentHandoff } from "./types.js";

function makeHandoff(findings: string): AgentHandoff {
  return {
    agentId: "a1",
    role: "planner",
    phase: "plan",
    summary: "Plan complete",
    findings,
    filesAnalyzed: [],
    filesModified: [],
    toolsUsed: 3,
    duration: 5000,
    timestamp: Date.now(),
  };
}

describe("extractTasksFromHandoff", () => {
  it("extracts bullet items as tasks", () => {
    const handoff = makeHandoff("## Plan\n- Refactor auth module\n- Add rate limiting\n- Update tests");
    const tasks = extractTasksFromHandoff(handoff);
    expect(tasks).toHaveLength(3);
    expect(tasks[0]?.title).toBe("Refactor auth module");
    expect(tasks[1]?.title).toBe("Add rate limiting");
    expect(tasks[2]?.title).toBe("Update tests");
  });

  it("handles asterisk bullets", () => {
    const handoff = makeHandoff("* First item\n* Second item");
    const tasks = extractTasksFromHandoff(handoff);
    expect(tasks).toHaveLength(2);
    expect(tasks[0]?.title).toBe("First item");
  });

  it("skips empty lines and non-bullet lines", () => {
    const handoff = makeHandoff("Some intro text\n\n- Actual task\n\nMore text\n- Another task");
    const tasks = extractTasksFromHandoff(handoff);
    expect(tasks).toHaveLength(2);
  });

  it("returns empty array when no bullets found", () => {
    const handoff = makeHandoff("No structured output here.");
    const tasks = extractTasksFromHandoff(handoff);
    expect(tasks).toHaveLength(0);
  });

  it("generates unique IDs for each task", () => {
    const handoff = makeHandoff("- Task A\n- Task B");
    const tasks = extractTasksFromHandoff(handoff);
    expect(tasks[0]?.id).not.toBe(tasks[1]?.id);
  });

  it("strips markdown formatting from titles", () => {
    const handoff = makeHandoff("- **Bold task** with `code`\n- [Link text](url)");
    const tasks = extractTasksFromHandoff(handoff);
    expect(tasks[0]?.title).toBe("Bold task with code");
    expect(tasks[1]?.title).toBe("Link text");
  });

  it("skips sub-bullets (indented items)", () => {
    const handoff = makeHandoff("- Main task\n  - Sub detail\n  - Another detail\n- Second task");
    const tasks = extractTasksFromHandoff(handoff);
    expect(tasks).toHaveLength(2);
    expect(tasks[0]?.title).toBe("Main task");
    expect(tasks[1]?.title).toBe("Second task");
  });
});
