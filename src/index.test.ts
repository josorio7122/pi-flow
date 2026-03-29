/**
 * Entry point smoke test — verifies the extension loads without errors
 * and registers the expected tools, commands, event handlers, and RPC channels.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import initExtension from "./index.js";

function createMockPi() {
  const tools: string[] = [];
  const toolDefs: Record<string, { promptSnippet?: string | undefined; promptGuidelines?: string[] | undefined }> = {};
  const commands: string[] = [];
  const eventHandlers = new Map<string, Array<(data: unknown) => void>>();
  const renderers: string[] = [];
  const emitted: string[] = [];

  const pi: ExtensionAPI = {
    registerTool: vi.fn((tool: { name: string; promptSnippet?: string; promptGuidelines?: string[] }) => {
      tools.push(tool.name);
      toolDefs[tool.name] = { promptSnippet: tool.promptSnippet, promptGuidelines: tool.promptGuidelines };
    }),
    registerCommand: vi.fn((name: string) => {
      commands.push(name);
    }),
    registerMessageRenderer: vi.fn((customType: string) => {
      renderers.push(customType);
    }),
    on: vi.fn((event: string, handler: unknown) => {
      const handlers = eventHandlers.get(event) ?? [];
      handlers.push(handler as (data: unknown) => void);
      eventHandlers.set(event, handlers);
    }),
    sendMessage: vi.fn(),
    appendEntry: vi.fn(),
    exec: vi.fn(),
    events: {
      emit: vi.fn((channel: string) => {
        emitted.push(channel);
      }),
      on: vi.fn(() => vi.fn()),
    },
    // Stubs for unused API methods
    registerShortcut: vi.fn(),
    registerFlag: vi.fn(),
    getFlag: vi.fn(),
    sendUserMessage: vi.fn(),
    setSessionName: vi.fn(),
    getSessionName: vi.fn(),
    setLabel: vi.fn(),
    getActiveTools: vi.fn(() => []),
    getAllTools: vi.fn(() => []),
    setActiveTools: vi.fn(),
    getCommands: vi.fn(() => []),
    setModel: vi.fn(),
    getThinkingLevel: vi.fn(),
    setThinkingLevel: vi.fn(),
    registerProvider: vi.fn(),
    unregisterProvider: vi.fn(),
  } as unknown as ExtensionAPI;

  return { pi, tools, toolDefs, commands, eventHandlers, renderers, emitted };
}

describe("extension entry point", () => {
  it("loads without throwing", () => {
    const { pi } = createMockPi();
    expect(() => initExtension(pi)).not.toThrow();
  });

  it("registers all three agent tools", () => {
    const { pi, tools } = createMockPi();
    initExtension(pi);
    expect(tools).toContain("Agent");
    expect(tools).toContain("get_subagent_result");
    expect(tools).toContain("steer_subagent");
  });

  it("registers the Workflow tool", () => {
    const { pi, tools } = createMockPi();
    initExtension(pi);
    expect(tools).toContain("Workflow");
  });

  it("registers /agents and /flow commands", () => {
    const { pi, commands } = createMockPi();
    initExtension(pi);
    expect(commands).toContain("agents");
    expect(commands).toContain("flow");
  });

  it("registers the notification message renderer", () => {
    const { pi, renderers } = createMockPi();
    initExtension(pi);
    expect(renderers).toContain("subagent-notification");
  });

  it("subscribes to lifecycle events", () => {
    const { pi, eventHandlers } = createMockPi();
    initExtension(pi);
    expect(eventHandlers.has("session_start")).toBe(true);
    expect(eventHandlers.has("session_switch")).toBe(true);
    expect(eventHandlers.has("session_shutdown")).toBe(true);
    expect(eventHandlers.has("tool_execution_start")).toBe(true);
    expect(eventHandlers.has("turn_end")).toBe(true);
  });

  it("emits subagents:ready on load", () => {
    const { pi, emitted } = createMockPi();
    initExtension(pi);
    expect(emitted).toContain("subagents:ready");
  });

  it("registers RPC handlers on event bus", () => {
    const { pi } = createMockPi();
    initExtension(pi);
    const onCalls = (pi.events.on as ReturnType<typeof vi.fn>).mock.calls.map((c: unknown[]) => c[0]);
    expect(onCalls).toContain("subagents:rpc:ping");
    expect(onCalls).toContain("subagents:rpc:spawn");
    expect(onCalls).toContain("subagents:rpc:stop");
  });

  it("Agent and Workflow tools include promptSnippet and promptGuidelines", () => {
    const { pi, toolDefs } = createMockPi();
    initExtension(pi);

    expect(toolDefs.Agent?.promptSnippet).toBeDefined();
    expect(toolDefs.Agent?.promptGuidelines).toBeDefined();
    expect(toolDefs.Agent!.promptGuidelines!.length).toBeGreaterThan(0);

    expect(toolDefs.Workflow?.promptSnippet).toBeDefined();
    expect(toolDefs.Workflow?.promptGuidelines).toBeDefined();
    expect(toolDefs.Workflow!.promptGuidelines!.length).toBeGreaterThan(0);
  });

  it("exposes manager on globalThis via Symbol.for", () => {
    const { pi } = createMockPi();
    initExtension(pi);
    const key = Symbol.for("pi-flow:manager");
    const exposed = (globalThis as Record<symbol, unknown>)[key] as Record<string, unknown>;
    expect(exposed).toBeDefined();
    expect(typeof exposed.waitForAll).toBe("function");
    expect(typeof exposed.hasRunning).toBe("function");
    expect(typeof exposed.spawn).toBe("function");
    expect(typeof exposed.getRecord).toBe("function");

    // Cleanup
    delete (globalThis as Record<symbol, unknown>)[key];
  });
});
