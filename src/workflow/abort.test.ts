import { describe, expect, it } from "vitest";
import { spawnWithAbort, WorkflowAbortError } from "./executor-helpers.js";

describe("spawnWithAbort", () => {
  it("throws WorkflowAbortError if signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();

    await expect(
      spawnWithAbort({
        manager: {} as any,
        pi: {} as any,
        ctx: {} as any,
        type: "builder",
        prompt: "test",
        description: "test",
        signal: controller.signal,
      }),
    ).rejects.toThrow(WorkflowAbortError);
  });

  it("aborts the spawned agent when signal fires", async () => {
    const controller = new AbortController();
    let abortedId: string | undefined;
    let resolvePromise: () => void;
    const agentPromise = new Promise<void>((resolve) => {
      resolvePromise = resolve;
    });

    const manager = {
      spawn: () => "agent-1",
      getRecord: () => ({ promise: agentPromise }),
      abort: (id: string) => {
        abortedId = id;
        resolvePromise();
        return true;
      },
    } as any;

    const resultPromise = spawnWithAbort({
      manager,
      pi: {} as any,
      ctx: {} as any,
      type: "builder",
      prompt: "test",
      description: "test",
      signal: controller.signal,
    });

    controller.abort();
    await resultPromise;

    expect(abortedId).toBe("agent-1");
  });

  it("works without signal (no abort)", async () => {
    const record = { promise: Promise.resolve(), id: "agent-1", turnCount: 2 };
    const manager = {
      spawn: () => "agent-1",
      getRecord: () => record,
    } as any;

    const result = await spawnWithAbort({
      manager,
      pi: {} as any,
      ctx: {} as any,
      type: "builder",
      prompt: "test",
      description: "test",
    });

    expect(result.id).toBe("agent-1");
  });
});
