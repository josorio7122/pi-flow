/**
 * Cross-extension RPC handlers for the subagents extension.
 *
 * Exposes ping, spawn, and stop RPCs over the pi.events event bus,
 * using per-request scoped reply channels.
 *
 * Reply envelope follows pi-mono convention:
 *   success → { success: true, data?: T }
 *   error   → { success: false, error: string }
 */

import type { EventBus } from "@mariozechner/pi-coding-agent";

/** RPC protocol version — bumped when the envelope or method contracts change. */
export const PROTOCOL_VERSION = 2;

/** Minimal AgentManager interface needed by the spawn/stop RPCs. */
export interface SpawnCapable {
  spawn(args: { pi: unknown; ctx: unknown; type: string; prompt: string; options: unknown }): string;
  abort(id: string): boolean;
}

export interface RpcDeps {
  events: EventBus;
  pi: unknown; // passed through to manager.spawn
  getCtx: () => unknown | undefined; // returns current ExtensionContext
  manager: SpawnCapable;
}

/**
 * Wire a single RPC handler: listen on `channel`, run `fn(params)`,
 * emit the reply envelope on `channel:reply:${requestId}`.
 */
function handleRpc<P extends { requestId: string }>({
  events,
  channel,
  fn,
}: {
  events: EventBus;
  channel: string;
  fn: (params: P) => unknown | Promise<unknown>;
}) {
  return events.on(channel, async (raw: unknown) => {
    const params = raw as P;
    try {
      const data = await fn(params);
      const reply: { success: true; data?: unknown } = { success: true };
      if (data !== undefined) reply.data = data;
      events.emit(`${channel}:reply:${params.requestId}`, reply);
    } catch (err: unknown) {
      events.emit(`${channel}:reply:${params.requestId}`, {
        success: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });
}

/**
 * Register ping, spawn, and stop RPC handlers on the event bus.
 * Returns unsub functions for cleanup.
 */
export function registerRpcHandlers(deps: RpcDeps) {
  const { events, pi, getCtx, manager } = deps;

  const unsubPing = handleRpc({
    events,
    channel: "subagents:rpc:ping",
    fn: () => ({ version: PROTOCOL_VERSION }),
  });

  const unsubSpawn = handleRpc<{ requestId: string; type: string; prompt: string; options?: unknown }>({
    events,
    channel: "subagents:rpc:spawn",
    fn: ({ type, prompt, options }) => {
      const ctx = getCtx();
      if (!ctx) throw new Error("No active session");
      return { id: manager.spawn({ pi, ctx, type, prompt, options: options ?? {} }) };
    },
  });

  const unsubStop = handleRpc<{ requestId: string; agentId: string }>({
    events,
    channel: "subagents:rpc:stop",
    fn: ({ agentId }) => {
      if (!manager.abort(agentId)) throw new Error("Agent not found");
    },
  });

  return { unsubPing, unsubSpawn, unsubStop };
}
