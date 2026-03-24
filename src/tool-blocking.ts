/**
 * Tool blocking — the coordinator can only write/edit inside .flow/.
 *
 * Extracted to a pure function for testability.
 * Uses path.normalize to prevent traversal attacks.
 */

import * as path from 'node:path';
import type { ToolCallEventResult } from '@mariozechner/pi-coding-agent';

const WRITE_TOOLS = new Set(['Write', 'Edit']);

const BLOCK_MESSAGE =
  'Coordinator cannot write outside .flow/. ' +
  'Dispatch builder for code changes. You may only write inside .flow/.';

/**
 * Checks if a file path targets the .flow/ directory.
 *
 * For relative paths: must start with ".flow/" after normalization.
 * For absolute paths: must contain "/.flow/" as a proper path segment.
 *
 * Rejects traversal attacks like "../.flow/exploit.md".
 */
export function isFlowPath(filePath: string): boolean {
  const normalized = path.normalize(filePath);

  // Relative path: must start with .flow/ after normalization.
  // path.normalize("../.flow/x") → "../.flow/x" — does NOT start with ".flow/", so blocked.
  // path.normalize("src/.flow/x") → "src/.flow/x" — does NOT start with ".flow/", so blocked.
  if (normalized.startsWith(`.flow${path.sep}`) || normalized === '.flow') {
    return true;
  }

  // Absolute path: must contain /.flow/ as a directory segment
  // and no remaining ".." after normalization.
  if (path.isAbsolute(normalized)) {
    const segments = normalized.split(path.sep);
    const flowIdx = segments.indexOf('.flow');
    if (flowIdx >= 0 && flowIdx < segments.length - 1 && !segments.includes('..')) {
      return true;
    }
  }

  return false;
}

/**
 * Determines whether a tool call should be blocked.
 *
 * - Write/Edit to .flow/ paths: allowed
 * - Write/Edit to anything else: BLOCKED
 * - Everything else (read, bash, dispatch_flow, etc.): allowed
 */
export function shouldBlockToolCall(
  toolName: string,
  input: Record<string, unknown>,
): ToolCallEventResult {
  if (!WRITE_TOOLS.has(toolName)) {
    return {};
  }

  const targetPath = input.path as string | undefined;
  if (!targetPath || !isFlowPath(targetPath)) {
    return { block: true, reason: BLOCK_MESSAGE };
  }

  return {};
}
