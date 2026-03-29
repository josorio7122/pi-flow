/**
 * runner.ts — Agent execution: run, resume, steer.
 * Types/settings in runner-types.ts, session creation in session.ts.
 */

import type { AgentSession, AgentSessionEvent, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { buildParentContext, extractText } from "../infra/context.js";
import type { SubagentType } from "../types.js";
import type { RunOptions, ToolActivity } from "./runner-types.js";
import { normalizeMaxTurns } from "./runner-types.js";
import { buildAgentSession } from "./session.js";

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

// ── Resume + Steer ───────────────────────────────────────────────────

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
