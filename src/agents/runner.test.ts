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
  createRunnerSettings,
  normalizeMaxTurns,
  resumeAgent,
  runAgent,
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

    const result = await runAgent({ ctx, type: "Explore", prompt: "Say LOCKED", options: { pi } });

    expect(result.responseText).toBe("LOCKED");
  });

  it("binds extensions before prompting", async () => {
    const { session } = createSession("BOUND");
    createAgentSession.mockResolvedValue({ session });

    await runAgent({ ctx, type: "Explore", prompt: "Say BOUND", options: { pi } });

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

    const result = await resumeAgent({ session: session as any, prompt: "Continue" });

    expect(result).toBe("RESUMED");
  });
});

describe("createRunnerSettings", () => {
  it("defaults to undefined maxTurns and graceTurns 5", () => {
    const s = createRunnerSettings();
    expect(s.defaultMaxTurns).toBeUndefined();
    expect(s.graceTurns).toBe(5);
  });

  it("settings are mutable", () => {
    const s = createRunnerSettings();
    s.defaultMaxTurns = 30;
    expect(s.defaultMaxTurns).toBe(30);
    s.defaultMaxTurns = undefined;
    expect(s.defaultMaxTurns).toBeUndefined();
    s.graceTurns = 10;
    expect(s.graceTurns).toBe(10);
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
