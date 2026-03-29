import { describe, it, expect, vi } from 'vitest';
import { FlowConversationViewer } from './conversation-viewer.js';
import type { BackgroundRecord } from '../background.js';
import type { FlowAgentConfig } from '../types.js';

function makeRecord(): BackgroundRecord {
  return {
    id: 'test-123',
    agent: { name: 'scout' } as FlowAgentConfig,
    task: 'scan code',
    description: 'Scan auth',
    status: 'completed' as const,
    startedAt: Date.now() - 5000,
    completedAt: Date.now(),
    abortController: new AbortController(),
  };
}

function makeTUI() {
  return {
    terminal: { columns: 80, rows: 24 },
    requestRender: vi.fn(),
  };
}

function makeTheme() {
  return {
    fg: (_: string, t: string) => t,
    bold: (t: string) => t,
  };
}

function makeSession(messages: Array<{ role: string; content: unknown }> = []) {
  return {
    messages,
    subscribe: vi.fn(() => () => {}),
  };
}

describe('FlowConversationViewer', () => {
  it('renders header with agent name and status', () => {
    const viewer = new FlowConversationViewer(
      makeTUI(),
      makeSession(),
      makeRecord(),
      undefined,
      makeTheme(),
      vi.fn(),
    );

    const lines = viewer.render(80);
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.some((l) => l.includes('scout'))).toBe(true);
    viewer.dispose();
  });

  it('renders messages', () => {
    const messages = [
      { role: 'user', content: 'Find auth files' },
      { role: 'assistant', content: [{ type: 'text', text: 'Found 3 files.' }] },
    ];
    const viewer = new FlowConversationViewer(
      makeTUI(),
      makeSession(messages),
      makeRecord(),
      undefined,
      makeTheme(),
      vi.fn(),
    );

    const lines = viewer.render(80);
    expect(lines.some((l) => l.includes('[User]'))).toBe(true);
    expect(lines.some((l) => l.includes('[Assistant]'))).toBe(true);
    expect(lines.some((l) => l.includes('Found 3 files'))).toBe(true);
    viewer.dispose();
  });

  it('handles escape key to close', () => {
    const done = vi.fn();
    const viewer = new FlowConversationViewer(
      makeTUI(),
      makeSession(),
      makeRecord(),
      undefined,
      makeTheme(),
      done,
    );

    viewer.handleInput('\x1b');
    expect(done).toHaveBeenCalledWith(undefined);
    viewer.dispose();
  });

  it('subscribes to session events', () => {
    const session = makeSession();
    const viewer = new FlowConversationViewer(
      makeTUI(),
      session,
      makeRecord(),
      undefined,
      makeTheme(),
      vi.fn(),
    );

    expect(session.subscribe).toHaveBeenCalledTimes(1);
    viewer.dispose();
  });
});
