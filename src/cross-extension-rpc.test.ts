import { describe, it, expect } from 'vitest';
import { registerRpcHandlers, PROTOCOL_VERSION } from './cross-extension-rpc.js';

function makeEventBus() {
  const handlers = new Map<string, Set<(data: unknown) => void>>();
  return {
    on: (event: string, handler: (data: unknown) => void) => {
      if (!handlers.has(event)) handlers.set(event, new Set());
      handlers.get(event)!.add(handler);
      return () => handlers.get(event)?.delete(handler);
    },
    emit: (event: string, data: unknown) => {
      for (const handler of handlers.get(event) ?? []) handler(data);
    },
    handlers,
  };
}

describe('registerRpcHandlers', () => {
  it('responds to ping with protocol version', async () => {
    const events = makeEventBus();
    registerRpcHandlers({ events, getManager: () => undefined });

    let reply: unknown;
    events.on('flow:rpc:ping:reply:req-1', (data) => {
      reply = data;
    });

    events.emit('flow:rpc:ping', { requestId: 'req-1' });
    await new Promise((r) => setTimeout(r, 10));

    expect(reply).toEqual({ success: true, data: { version: PROTOCOL_VERSION } });
  });

  it('stop errors when no manager', async () => {
    const events = makeEventBus();
    registerRpcHandlers({ events, getManager: () => undefined });

    let reply: unknown;
    events.on('flow:rpc:stop:reply:req-2', (data) => {
      reply = data;
    });

    events.emit('flow:rpc:stop', { requestId: 'req-2', agentId: 'x' });
    await new Promise((r) => setTimeout(r, 10));

    expect(reply).toEqual(expect.objectContaining({ success: false }));
  });

  it('unsub functions clean up handlers', () => {
    const events = makeEventBus();
    const { unsubPing, unsubSpawn, unsubStop } = registerRpcHandlers({
      events,
      getManager: () => undefined,
    });

    expect(events.handlers.get('flow:rpc:ping')?.size).toBe(1);
    unsubPing();
    expect(events.handlers.get('flow:rpc:ping')?.size).toBe(0);
    unsubSpawn();
    unsubStop();
  });
});
