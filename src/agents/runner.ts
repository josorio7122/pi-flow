/**
 * runner.ts — Agent execution: run, resume, steer, collect results.
 * Session creation delegated to session.ts.
 */

import type { ThinkingLevel } from "@mariozechner/pi-agent-core";
import type { Api, Model } from "@mariozechner/pi-ai";
import type { AgentSession, AgentSessionEvent, ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { buildParentContext, extractText } from "../infra/context.js";
import type { SubagentType } from "../types.js";
import type { Registry } from "./registry.js";
import { buildAgentSession } from "./session.js";

export interface ToolActivity {
  type: "start" | "end";
  toolName: string;
}

export interface RunnerSettings {
  defaultMaxTurns: number | undefined;
  graceTurns: number;
}

export function normalizeMaxTurns(n: number | undefined) {
  if (n == null || n === 0) return undefined;
  return Math.max(1, Math.round(n));
}

export function createRunnerSettings(): RunnerSettings {
  return { defaultMaxTurns: undefined, graceTurns: 5 };
}

export interface RunOptions {
  pi: ExtensionAPI;
  description?: string | undefined;
  model?: Model<Api> | undefined;
  maxTurns?: number | undefined;
  signal?: AbortSignal | undefined;
  isolated?: boolean | undefined;
  inheritContext?: boolean | undefined;
  thinkingLevel?: ThinkingLevel | undefined;
  cwd?: string | undefined;
  onToolActivity?: ((activity: ToolActivity) => void) | undefined;
  onTextDelta?: ((delta: string, fullText: string) => void) | undefined;
  onSessionCreated?: ((session: AgentSession) => void) | undefined;
  onTurnEnd?: ((turnCount: number) => void) | undefined;
  settings?: RunnerSettings | undefined;
  registry?: Registry | undefined;
}

// ── Helpers ──────────────────────────────────────────────────────────

function collectResponseText(session: AgentSession) {
  let text = "";
  const unsubscribe = session.subscribe((event: AgentSessionEvent) => {
    if (event.type === "message_start") text = "";
    if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta")
      text += event.assistantMessageEvent.delta;
  });
  return { getText: () => text, unsubscribe };
}

function getLastAssistantText(session: AgentSession) {
  for (let i = session.messages.length - 1; i >= 0; i--) {
    const msg = session.messages[i];
    if (!msg || msg.role !== "assistant") continue;
    const text = extractText(msg.content).trim();
    if (text) return text;
  }
  return "";
}

function forwardAbortSignal(session: AgentSession, signal?: AbortSignal) {
  if (!signal) return () => {};
  const onAbort = () => session.abort();
  signal.addEventListener("abort", onAbort, { once: true });
  return () => signal.removeEventListener("abort", onAbort);
}

// ── Run Agent ────────────────────────────────────────────────────────

export async function runAgent({
  ctx,
  type,
  prompt,
  options,
}: {
  ctx: ExtensionContext;
  type: SubagentType;
  prompt: string;
  options: RunOptions;
}) {
  const { session, agentConfig } = await buildAgentSession({
    ctx,
    type,
    options: {
      pi: options.pi,
      registry: options.registry!,
      cwd: options.cwd,
      model: options.model,
      isolated: options.isolated,
      thinkingLevel: options.thinkingLevel,
      onToolActivity: options.onToolActivity,
    },
  });

  options.onSessionCreated?.(session);

  let turnCount = 0;
  const maxTurns = normalizeMaxTurns(options.maxTurns ?? agentConfig?.maxTurns ?? options.settings?.defaultMaxTurns);
  let softLimitReached = false;
  let aborted = false;

  let currentMessageText = "";
  const unsubTurns = session.subscribe((event: AgentSessionEvent) => {
    if (event.type === "turn_end") {
      turnCount++;
      options.onTurnEnd?.(turnCount);
      if (maxTurns != null) {
        if (!softLimitReached && turnCount >= maxTurns) {
          softLimitReached = true;
          session.steer("You have reached your turn limit. Wrap up immediately — provide your final answer now.");
        } else if (softLimitReached && turnCount >= maxTurns + (options.settings?.graceTurns ?? 5)) {
          aborted = true;
          session.abort();
        }
      }
    }
    if (event.type === "message_start") currentMessageText = "";
    if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
      currentMessageText += event.assistantMessageEvent.delta;
      options.onTextDelta?.(event.assistantMessageEvent.delta, currentMessageText);
    }
    if (event.type === "tool_execution_start") options.onToolActivity?.({ type: "start", toolName: event.toolName });
    if (event.type === "tool_execution_end") options.onToolActivity?.({ type: "end", toolName: event.toolName });
  });

  const collector = collectResponseText(session);
  const cleanupAbort = forwardAbortSignal(session, options.signal);

  let effectivePrompt = prompt;
  if (options.inheritContext) {
    const parentContext = buildParentContext(ctx);
    if (parentContext) effectivePrompt = parentContext + prompt;
  }

  try {
    await session.prompt(effectivePrompt);
  } finally {
    unsubTurns();
    collector.unsubscribe();
    cleanupAbort();
  }

  const responseText = collector.getText().trim() || getLastAssistantText(session);
  return { responseText, session, aborted, steered: softLimitReached };
}

// ── Resume + Steer + Conversation ────────────────────────────────────

export async function resumeAgent({
  session,
  prompt,
  signal,
  callbacks,
}: {
  session: AgentSession;
  prompt: string;
  signal?: AbortSignal | undefined;
  callbacks?: { onToolActivity?: (a: ToolActivity) => void; onTurnEnd?: (t: number) => void } | undefined;
}) {
  let turnCount = 0;
  const unsubTurns = session.subscribe((event: AgentSessionEvent) => {
    if (event.type === "turn_end") {
      turnCount++;
      callbacks?.onTurnEnd?.(turnCount);
    }
    if (event.type === "tool_execution_start") callbacks?.onToolActivity?.({ type: "start", toolName: event.toolName });
    if (event.type === "tool_execution_end") callbacks?.onToolActivity?.({ type: "end", toolName: event.toolName });
  });
  const collector = collectResponseText(session);
  const cleanupAbort = forwardAbortSignal(session, signal);

  try {
    await session.prompt(prompt);
  } finally {
    unsubTurns();
    collector.unsubscribe();
    cleanupAbort();
  }
  return collector.getText().trim() || getLastAssistantText(session);
}

export async function steerAgent(session: AgentSession, message: string) {
  session.steer(message);
}

export function getAgentConversation(session: AgentSession) {
  return session.messages
    .map((msg) => {
      if (msg.role === "user") {
        const text = typeof msg.content === "string" ? msg.content : extractText(msg.content);
        return `[User]\n${text}`;
      }
      if (msg.role === "assistant") {
        const text = msg.content
          .filter((c) => c.type === "text")
          .map((c) => (c as { text: string }).text)
          .join("\n");
        const tools = msg.content.filter((c) => c.type === "toolCall").map((c) => (c as { name: string }).name);
        return `[Assistant]\n${text}${tools.length ? `\n[Tools: ${tools.join(", ")}]` : ""}`;
      }
      if (msg.role === "toolResult") {
        const text = extractText(msg.content);
        return `[Tool Result]\n${text.slice(0, 200)}${text.length > 200 ? "..." : ""}`;
      }
      return null;
    })
    .filter(Boolean)
    .join("\n\n");
}
