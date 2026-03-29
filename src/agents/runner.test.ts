import { beforeEach, describe, expect, it, vi } from "vitest";

const { createAgentSession } = vi.hoisted(() => ({
  createAgentSession: vi.fn(),
}));

vi.mock("@mariozechner/pi-coding-agent", () => ({
  createAgentSession,
  DefaultResourceLoader: class {
    async reload() {}
  },
  SessionManager: { inMemory: vi.fn(() => ({ kind: "memory-session-manager" })) },
  SettingsManager: { create: vi.fn(() => ({ kind: "settings-manager" })) },
}));

vi.mock("./registry.js", () => ({
  getConfig: vi.fn(() => ({
    displayName: "Explore",
    description: "Explore",
    builtinToolNames: ["read"],
    extensions: false,
    skills: false,
    promptMode: "replace",
  })),
  getAgentConfig: vi.fn(() => ({
    name: "Explore",
    description: "Explore",
    builtinToolNames: ["read"],
    extensions: false,
    skills: false,
    systemPrompt: "You are Explore.",
    promptMode: "replace",
    inheritContext: false,
    runInBackground: false,
    isolated: false,
  })),
  getMemoryTools: vi.fn(() => []),
  getReadOnlyMemoryTools: vi.fn(() => []),
  getToolsForType: vi.fn(() => [{ name: "read" }]),
}));

vi.mock("../infra/env.js", () => ({
  detectEnv: vi.fn(async () => ({ isGitRepo: false, branch: "", platform: "linux" })),
}));

vi.mock("../config/prompts.js", () => ({
  buildAgentPrompt: vi.fn(() => "system prompt"),
}));

vi.mock("../infra/memory.js", () => ({
  buildMemoryBlock: vi.fn(() => ""),
  buildReadOnlyMemoryBlock: vi.fn(() => ""),
}));

vi.mock("../config/skill-loader.js", () => ({
  preloadSkills: vi.fn(() => []),
}));

import {
  getDefaultMaxTurns,
  getGraceTurns,
  normalizeMaxTurns,
  resumeAgent,
  runAgent,
  setDefaultMaxTurns,
  setGraceTurns,
} from "./runner.js";

function createSession(finalText: string) {
  const listeners: Array<(event: any) => void> = [];
  const session = {
    messages: [] as any[],
    subscribe: vi.fn((listener: (event: any) => void) => {
      listeners.push(listener);
      return () => {};
    }),
    prompt: vi.fn(async () => {
      session.messages.push({
        role: "assistant",
        content: [{ type: "text", text: finalText }],
      });
    }),
    abort: vi.fn(),
    steer: vi.fn(),
    getActiveToolNames: vi.fn(() => ["read"]),
    setActiveToolsByName: vi.fn(),
    bindExtensions: vi.fn(async () => {}),
  };
  return { session, listeners };
}

const ctx = {
  cwd: "/tmp",
  model: undefined,
  modelRegistry: { find: vi.fn(), getAvailable: vi.fn(() => []) },
  getSystemPrompt: vi.fn(() => "parent prompt"),
  sessionManager: { getBranch: vi.fn(() => []) },
} as any;

const pi = {} as any;

beforeEach(() => {
  createAgentSession.mockReset();
});

describe("agent-runner final output capture", () => {
  it("returns the final assistant text even when no text_delta events were streamed", async () => {
    const { session } = createSession("LOCKED");
    createAgentSession.mockResolvedValue({ session });

    const result = await runAgent(ctx, "Explore", "Say LOCKED", { pi });

    expect(result.responseText).toBe("LOCKED");
  });

  it("binds extensions before prompting", async () => {
    const { session } = createSession("BOUND");
    createAgentSession.mockResolvedValue({ session });

    await runAgent(ctx, "Explore", "Say BOUND", { pi });

    expect(session.bindExtensions).toHaveBeenCalledTimes(1);
    expect(session.bindExtensions).toHaveBeenCalledWith(
      expect.objectContaining({ onError: expect.any(Function) }),
    );

    const bindOrder = session.bindExtensions.mock.invocationCallOrder[0]!;
    const promptOrder = session.prompt.mock.invocationCallOrder[0]!;
    expect(bindOrder).toBeLessThan(promptOrder);
  });

  it("resumeAgent also falls back to the final assistant message text", async () => {
    const { session } = createSession("RESUMED");

    const result = await resumeAgent(session as any, "Continue");

    expect(result).toBe("RESUMED");
  });
});

describe("setDefaultMaxTurns / getDefaultMaxTurns", () => {
  beforeEach(() => {
    setDefaultMaxTurns(undefined);
  });

  it("defaults to undefined (unlimited)", () => {
    expect(getDefaultMaxTurns()).toBeUndefined();
  });

  it("stores a positive integer", () => {
    setDefaultMaxTurns(30);
    expect(getDefaultMaxTurns()).toBe(30);
  });

  it("accepts boundary value 1", () => {
    setDefaultMaxTurns(1);
    expect(getDefaultMaxTurns()).toBe(1);
  });

  it("treats 0 as unlimited", () => {
    setDefaultMaxTurns(0);
    expect(getDefaultMaxTurns()).toBeUndefined();
  });

  it("clamps negative values to 1", () => {
    setDefaultMaxTurns(-10);
    expect(getDefaultMaxTurns()).toBe(1);
  });

  it("undefined resets to unlimited after being set", () => {
    setDefaultMaxTurns(50);
    expect(getDefaultMaxTurns()).toBe(50);
    setDefaultMaxTurns(undefined);
    expect(getDefaultMaxTurns()).toBeUndefined();
  });
});

describe("normalizeMaxTurns", () => {
  it("treats undefined as unlimited", () => {
    expect(normalizeMaxTurns(undefined)).toBeUndefined();
  });

  it("treats 0 as unlimited", () => {
    expect(normalizeMaxTurns(0)).toBeUndefined();
  });

  it("keeps positive values", () => {
    expect(normalizeMaxTurns(7)).toBe(7);
  });

  it("clamps negative values to 1", () => {
    expect(normalizeMaxTurns(-3)).toBe(1);
  });
});

describe("setGraceTurns / getGraceTurns", () => {
  beforeEach(() => {
    setGraceTurns(5);
  });

  it("defaults to 5", () => {
    expect(getGraceTurns()).toBe(5);
  });

  it("stores a positive integer", () => {
    setGraceTurns(10);
    expect(getGraceTurns()).toBe(10);
  });

  it("accepts boundary value 1", () => {
    setGraceTurns(1);
    expect(getGraceTurns()).toBe(1);
  });

  it("clamps 0 to 1", () => {
    setGraceTurns(0);
    expect(getGraceTurns()).toBe(1);
  });

  it("clamps negative values to 1", () => {
    setGraceTurns(-5);
    expect(getGraceTurns()).toBe(1);
  });
});
