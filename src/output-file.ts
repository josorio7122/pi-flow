/**
 * output-file.ts — Streaming JSONL output file for agent transcripts.
 *
 * Creates a per-agent output file that streams conversation turns as JSONL.
 * Used for post-mortem debugging of background agents.
 */

import { appendFileSync, chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Create the output file path, ensuring the directory exists.
 * Layout: /tmp/pi-flow-{uid}/{encoded-cwd}/{sessionId}/tasks/{agentId}.output
 */
export function createOutputFilePath(cwd: string, agentId: string, sessionId: string): string {
  const encoded = cwd.replace(/\//g, '-').replace(/^-/, '');
  const root = join(tmpdir(), `pi-flow-${process.getuid?.() ?? 0}`);
  mkdirSync(root, { recursive: true, mode: 0o700 });
  try {
    chmodSync(root, 0o700);
  } catch {
    /* ignore on platforms without chmod */
  }
  const dir = join(root, encoded, sessionId, 'tasks');
  mkdirSync(dir, { recursive: true });
  return join(dir, `${agentId}.output`);
}

/**
 * Write the initial user prompt entry to the output file.
 */
export function writeInitialEntry(
  filePath: string,
  agentId: string,
  prompt: string,
  cwd: string,
): void {
  const entry = {
    isSidechain: true,
    agentId,
    type: 'user',
    message: { role: 'user', content: prompt },
    timestamp: new Date().toISOString(),
    cwd,
  };
  writeFileSync(filePath, JSON.stringify(entry) + '\n', 'utf-8');
}

/**
 * Subscribe to session events and flush new messages to the output file on each turn_end.
 * Returns a cleanup function that does a final flush and unsubscribes.
 *
 * @param session — The AgentSession (typed as unknown to avoid importing pi SDK in this file)
 */
export function streamToOutputFile(
  session: {
    messages: Array<{ role: string; content: unknown }>;
    subscribe(fn: (event: { type: string }) => void): () => void;
  },
  filePath: string,
  agentId: string,
  cwd: string,
): () => void {
  let writtenCount = 1; // initial user prompt already written

  const flush = () => {
    const messages = session.messages;
    while (writtenCount < messages.length) {
      const msg = messages[writtenCount];
      const entry = {
        isSidechain: true,
        agentId,
        type: msg.role === 'assistant' ? 'assistant' : msg.role === 'user' ? 'user' : 'toolResult',
        message: msg,
        timestamp: new Date().toISOString(),
        cwd,
      };
      try {
        appendFileSync(filePath, JSON.stringify(entry) + '\n', 'utf-8');
      } catch {
        /* ignore write errors */
      }
      writtenCount++;
    }
  };

  const unsubscribe = session.subscribe((event) => {
    if (event.type === 'turn_end') flush();
  });

  return () => {
    flush();
    unsubscribe();
  };
}
