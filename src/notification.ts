/**
 * notification.ts — Completion notification formatting and nudge management.
 *
 * Provides:
 * - XML task-notification format for machine-parseable notifications
 * - Cancellable pending nudges (200ms hold window)
 * - Group notification building
 */

import type { BackgroundRecord } from './background.js';
import { getFinalOutput } from './result-utils.js';

// ─── XML Notification Format ──────────────────────────────────────────────────

function escapeXml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function getStatusLabel(status: string, error?: string): string {
  switch (status) {
    case 'error':
      return `Error: ${error ?? 'unknown'}`;
    case 'aborted':
      return 'Aborted (max turns exceeded)';
    case 'steered':
      return 'Wrapped up (turn limit)';
    default:
      return 'Done';
  }
}

/**
 * Format a structured task notification in XML format.
 */
export function formatTaskNotification(record: BackgroundRecord, resultMaxLen = 500): string {
  const status = getStatusLabel(record.status, record.error);
  const durationMs = record.completedAt ? record.completedAt - record.startedAt : 0;

  const resultPreview = record.result
    ? (() => {
        const output = getFinalOutput(record.result!.messages);
        return output.length > resultMaxLen
          ? output.slice(0, resultMaxLen) + '\n...(truncated, use get_agent_result for full output)'
          : output;
      })()
    : 'No output.';

  return [
    '<task-notification>',
    `<task-id>${record.id}</task-id>`,
    record.outputFile ? `<output-file>${escapeXml(record.outputFile)}</output-file>` : null,
    `<status>${escapeXml(status)}</status>`,
    `<summary>Agent "${escapeXml(record.description)}" ${record.status}</summary>`,
    `<result>${escapeXml(resultPreview)}</result>`,
    `<usage><tool_uses>${record.toolUses ?? 0}</tool_uses><duration_ms>${durationMs}</duration_ms></usage>`,
    '</task-notification>',
  ]
    .filter(Boolean)
    .join('\n');
}

// ─── Notification Details ─────────────────────────────────────────────────────

export interface NotificationDetails {
  id: string;
  description: string;
  status: string;
  toolUses: number;
  durationMs: number;
  outputFile?: string;
  error?: string;
  resultPreview: string;
  others?: NotificationDetails[];
}

export function buildNotificationDetails(
  record: BackgroundRecord,
  resultMaxLen = 500,
): NotificationDetails {
  const output = record.result ? getFinalOutput(record.result.messages) : '';
  return {
    id: record.id,
    description: record.description,
    status: record.status,
    toolUses: record.toolUses ?? 0,
    durationMs: record.completedAt ? record.completedAt - record.startedAt : 0,
    outputFile: record.outputFile,
    error: record.error,
    resultPreview:
      output.length > resultMaxLen ? output.slice(0, resultMaxLen) + '…' : output || 'No output.',
  };
}

// ─── Cancellable Nudges ───────────────────────────────────────────────────────

const NUDGE_HOLD_MS = 200;

/**
 * Manages cancellable pending notifications.
 * Notifications are held briefly so get_agent_result can cancel them
 * before they reach the user.
 */
export class NudgeManager {
  private pending = new Map<string, ReturnType<typeof setTimeout>>();

  /** Schedule a nudge with a short delay. If cancelled before firing, it's suppressed. */
  schedule(key: string, send: () => void, delay = NUDGE_HOLD_MS): void {
    this.cancel(key);
    this.pending.set(
      key,
      setTimeout(() => {
        this.pending.delete(key);
        send();
      }, delay),
    );
  }

  /** Cancel a pending nudge. */
  cancel(key: string): void {
    const timer = this.pending.get(key);
    if (timer != null) {
      clearTimeout(timer);
      this.pending.delete(key);
    }
  }

  /** Dispose all pending nudges. */
  dispose(): void {
    for (const timer of this.pending.values()) clearTimeout(timer);
    this.pending.clear();
  }
}
