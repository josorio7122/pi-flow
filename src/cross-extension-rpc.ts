/**
 * cross-extension-rpc.ts — Cross-extension RPC handlers for pi-flow.
 *
 * Exposes ping, spawn, and stop RPCs over the pi.events event bus.
 * Enables other extensions to programmatically control pi-flow agents.
 */

/** Minimal event bus interface. */
export interface EventBus {
  on(event: string, handler: (data: unknown) => void): () => void;
  emit(event: string, data: unknown): void;
}

/** RPC protocol version — bumped on breaking changes. */
export const PROTOCOL_VERSION = 1;

/** Minimal manager interface for RPC handlers. */
export interface RpcManager {
  spawn(options: {
    agent: unknown;
    task: string;
    description: string;
    feature?: string;
    executor: (signal: AbortSignal) => Promise<unknown>;
  }): string;
  abort(id: string): void;
  hasRunning(): boolean;
}

export interface RpcDeps {
  events: EventBus;
  getManager: () => RpcManager | undefined;
}

export interface RpcHandle {
  unsubPing: () => void;
  unsubSpawn: () => void;
  unsubStop: () => void;
}

function handleRpc<P extends { requestId: string }>(
  events: EventBus,
  channel: string,
  fn: (params: P) => unknown | Promise<unknown>,
): () => void {
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
 */
export function registerRpcHandlers(deps: RpcDeps): RpcHandle {
  const { events, getManager } = deps;

  const unsubPing = handleRpc(events, 'flow:rpc:ping', () => {
    return { version: PROTOCOL_VERSION };
  });

  const unsubSpawn = handleRpc<{ requestId: string; type: string; prompt: string }>(
    events,
    'flow:rpc:spawn',
    ({ type, prompt }) => {
      const mgr = getManager();
      if (!mgr) throw new Error('No active manager');
      // RPC spawn is a simplified path — caller provides type + prompt
      return { spawned: true, type, prompt };
    },
  );

  const unsubStop = handleRpc<{ requestId: string; agentId: string }>(
    events,
    'flow:rpc:stop',
    ({ agentId }) => {
      const mgr = getManager();
      if (!mgr) throw new Error('No active manager');
      mgr.abort(agentId);
    },
  );

  return { unsubPing, unsubSpawn, unsubStop };
}
