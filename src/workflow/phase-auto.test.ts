import { describe, expect, it } from "vitest";

describe("auto phase", () => {
  it("returns needs-planning when no tasks are set", async () => {
    const { executeAutoPhase } = await import("./phase-auto.js");
    const result = executeAutoPhase({ tasks: undefined });
    expect(result).toEqual({ type: "needs-planning" });
  });

  it("returns needs-planning when tasks is empty", async () => {
    const { executeAutoPhase } = await import("./phase-auto.js");
    const result = executeAutoPhase({ tasks: [] });
    expect(result).toEqual({ type: "needs-planning" });
  });
});
