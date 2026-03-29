import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { createOutputFilePath, writeInitialEntry, streamToOutputFile } from './output-file.js';

describe('createOutputFilePath', () => {
  it('creates a path under tmpdir', () => {
    const result = createOutputFilePath('/my/project', 'agent-123', 'session-456');
    expect(result).toContain('pi-flow-');
    expect(result).toContain('agent-123.output');
    expect(result).toContain('session-456');
  });

  it('creates the directory', () => {
    const result = createOutputFilePath('/my/project', 'test-agent', 'test-session');
    expect(fs.existsSync(path.dirname(result))).toBe(true);
  });
});

describe('writeInitialEntry', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flow-output-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('writes a JSONL entry with the user prompt', () => {
    const filePath = path.join(tmpDir, 'test.output');
    writeInitialEntry(filePath, 'agent-1', 'Do something', '/my/project');

    const content = fs.readFileSync(filePath, 'utf-8');
    const entry = JSON.parse(content.trim());
    expect(entry.agentId).toBe('agent-1');
    expect(entry.type).toBe('user');
    expect(entry.message.content).toBe('Do something');
    expect(entry.isSidechain).toBe(true);
  });
});

describe('streamToOutputFile', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flow-stream-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('flushes messages on turn_end events', () => {
    const filePath = path.join(tmpDir, 'stream.output');
    fs.writeFileSync(filePath, ''); // empty initial file

    const messages = [
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: [{ type: 'text', text: 'hi' }] },
    ];
    let handler: ((e: { type: string }) => void) | undefined;
    const session = {
      messages,
      subscribe: (fn: (e: { type: string }) => void) => {
        handler = fn;
        return () => {
          handler = undefined;
        };
      },
    };

    const cleanup = streamToOutputFile(session, filePath, 'agent-1', '/test');

    // Trigger turn_end
    handler?.({ type: 'turn_end' });

    const lines = fs.readFileSync(filePath, 'utf-8').trim().split('\n');
    // writtenCount starts at 1 (initial entry assumed), so it writes messages[1]
    expect(lines).toHaveLength(1);
    const entry = JSON.parse(lines[0]);
    expect(entry.type).toBe('assistant');

    // Cleanup does a final flush
    messages.push({ role: 'user', content: 'more' });
    cleanup();

    const finalLines = fs.readFileSync(filePath, 'utf-8').trim().split('\n');
    expect(finalLines).toHaveLength(2);
  });
});
