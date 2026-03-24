import * as fs from 'node:fs';
import * as path from 'node:path';

// ─── ensureMemoryDir ──────────────────────────────────────────────────────────

/**
 * Creates `.flow/memory/` inside flowDir if it doesn't exist.
 * Returns the absolute path to the memory directory.
 */
export function ensureMemoryDir(flowDir: string): string {
  const memDir = path.join(flowDir, 'memory');
  fs.mkdirSync(memDir, { recursive: true });
  return memDir;
}

// ─── appendDecision ───────────────────────────────────────────────────────────

export interface DecisionEntry {
  feature: string;
  summary: string;
  approach: string;
  outcome: string;
  date: string;
}

/**
 * Appends a decision entry to `.flow/memory/decisions.md`.
 */
export function appendDecision(flowDir: string, decision: DecisionEntry): void {
  const memDir = ensureMemoryDir(flowDir);
  const filePath = path.join(memDir, 'decisions.md');
  const entry = [
    `## ${decision.feature} — ${decision.date}`,
    `**Decision:** ${decision.summary}`,
    `**Approach:** ${decision.approach}`,
    `**Outcome:** ${decision.outcome}`,
    '---',
    '',
  ].join('\n');
  fs.appendFileSync(filePath, entry, 'utf8');
}

// ─── appendPattern ────────────────────────────────────────────────────────────

export interface PatternEntry {
  name: string;
  description: string;
  files: string[];
  date: string;
}

/**
 * Appends a pattern entry to `.flow/memory/patterns.md`.
 */
export function appendPattern(flowDir: string, pattern: PatternEntry): void {
  const memDir = ensureMemoryDir(flowDir);
  const filePath = path.join(memDir, 'patterns.md');
  const entry = [
    `## ${pattern.name} — first seen ${pattern.date}`,
    pattern.description,
    `**Files:** ${pattern.files.join(', ')}`,
    '---',
    '',
  ].join('\n');
  fs.appendFileSync(filePath, entry, 'utf8');
}

// ─── appendLesson ─────────────────────────────────────────────────────────────

export interface LessonEntry {
  title: string;
  description: string;
  resolution: string;
  date: string;
}

/**
 * Appends a lesson entry to `.flow/memory/lessons.md`.
 */
export function appendLesson(flowDir: string, lesson: LessonEntry): void {
  const memDir = ensureMemoryDir(flowDir);
  const filePath = path.join(memDir, 'lessons.md');
  const entry = [
    `## ${lesson.title} — ${lesson.date}`,
    lesson.description,
    `**Resolution:** ${lesson.resolution}`,
    '---',
    '',
  ].join('\n');
  fs.appendFileSync(filePath, entry, 'utf8');
}

// ─── readMemoryFile ───────────────────────────────────────────────────────────

/**
 * Reads a memory file by filename (e.g. 'decisions.md').
 * Returns the file content or an empty string if it doesn't exist.
 */
export function readMemoryFile(flowDir: string, filename: string): string {
  const filePath = path.join(flowDir, 'memory', filename);
  if (!fs.existsSync(filePath)) return '';
  return fs.readFileSync(filePath, 'utf8');
}


