import { describe, it, expect, vi } from 'vitest';
import { formatTaskNotification, buildNotificationDetails, NudgeManager } from './notification.js';
import type { BackgroundRecord } from './background.js';
import type { FlowAgentConfig, SingleAgentResult } from './types.js';

function makeRecord(overrides: Partial<BackgroundRecord> = {}): BackgroundRecord {
  return {
    id: 'test-123',
    agent: { name: 'scout' } as FlowAgentConfig,
    task: 'scan code',
    description: 'Scan auth module',
    status: 'completed',
    startedAt: 1000,
    completedAt: 2500,
    abortController: new AbortController(),
    result: {
      agent: 'scout',
      agentSource: 'builtin',
      task: 'scan code',
      exitCode: 0,
      messages: [{ role: 'assistant', content: [{ type: 'text', text: 'Found 3 files.' }] }],
      stderr: '',
      usage: {
        input: 100,
        output: 50,
        cacheRead: 0,
        cacheWrite: 0,
        cost: 0.01,
        contextTokens: 150,
        turns: 3,
      },
    } as SingleAgentResult,
    ...overrides,
  };
}

describe('formatTaskNotification', () => {
  it('produces XML with task-notification tags', () => {
    const xml = formatTaskNotification(makeRecord());
    expect(xml).toContain('<task-notification>');
    expect(xml).toContain('<task-id>test-123</task-id>');
    expect(xml).toContain('</task-notification>');
    expect(xml).toContain('<status>Done</status>');
    expect(xml).toContain('Found 3 files.');
  });

  it('includes output file when present', () => {
    const xml = formatTaskNotification(makeRecord({ outputFile: '/tmp/test.output' }));
    expect(xml).toContain('<output-file>/tmp/test.output</output-file>');
  });

  it('escapes XML special characters', () => {
    const xml = formatTaskNotification(makeRecord({ description: 'Test <script>&' }));
    expect(xml).toContain('&lt;script&gt;&amp;');
  });

  it('shows error status', () => {
    const xml = formatTaskNotification(makeRecord({ status: 'error', error: 'boom' }));
    expect(xml).toContain('Error: boom');
  });
});

describe('buildNotificationDetails', () => {
  it('builds details object', () => {
    const details = buildNotificationDetails(makeRecord());
    expect(details.id).toBe('test-123');
    expect(details.description).toBe('Scan auth module');
    expect(details.status).toBe('completed');
    expect(details.durationMs).toBe(1500);
    expect(details.resultPreview).toContain('Found 3 files.');
  });
});

describe('NudgeManager', () => {
  it('fires scheduled nudge after delay', async () => {
    const mgr = new NudgeManager();
    const send = vi.fn();
    mgr.schedule('test', send, 50);

    expect(send).not.toHaveBeenCalled();
    await new Promise((r) => setTimeout(r, 100));
    expect(send).toHaveBeenCalledTimes(1);
    mgr.dispose();
  });

  it('cancels nudge before it fires', async () => {
    const mgr = new NudgeManager();
    const send = vi.fn();
    mgr.schedule('test', send, 50);
    mgr.cancel('test');

    await new Promise((r) => setTimeout(r, 100));
    expect(send).not.toHaveBeenCalled();
    mgr.dispose();
  });

  it('replaces existing nudge on same key', async () => {
    const mgr = new NudgeManager();
    const send1 = vi.fn();
    const send2 = vi.fn();
    mgr.schedule('test', send1, 50);
    mgr.schedule('test', send2, 50);

    await new Promise((r) => setTimeout(r, 100));
    expect(send1).not.toHaveBeenCalled();
    expect(send2).toHaveBeenCalledTimes(1);
    mgr.dispose();
  });

  it('dispose clears all pending', async () => {
    const mgr = new NudgeManager();
    const send = vi.fn();
    mgr.schedule('a', send, 50);
    mgr.schedule('b', send, 50);
    mgr.dispose();

    await new Promise((r) => setTimeout(r, 100));
    expect(send).not.toHaveBeenCalled();
  });
});
