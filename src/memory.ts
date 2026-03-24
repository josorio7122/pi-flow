import * as fs from 'node:fs';
import * as path from 'node:path';

// ─── ensureMemoryDir ──────────────────────────────────────────────────────────

/**
 * Creates `.flow/memory/` inside flowDir if it doesn't exist.
 * Returns the absolute path to the memory directory.
 */
export function ensureMemoryDir(flowDir: string): string {
  const memDir = path.join(flowDir, '.flow', 'memory');
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
  const filePath = path.join(flowDir, '.flow', 'memory', filename);
  if (!fs.existsSync(filePath)) return '';
  return fs.readFileSync(filePath, 'utf8');
}

// ─── searchMemory ─────────────────────────────────────────────────────────────

/**
 * Splits markdown content into sections delimited by ## headings.
 * Returns an array of section strings (each includes its heading line).
 */
function splitIntoSections(content: string): string[] {
  const sections: string[] = [];
  const lines = content.split('\n');
  let current: string[] = [];

  for (const line of lines) {
    if (line.startsWith('## ') && current.length > 0) {
      sections.push(current.join('\n'));
      current = [line];
    } else {
      current.push(line);
    }
  }
  if (current.length > 0 && current.some((l) => l.trim() !== '')) {
    sections.push(current.join('\n'));
  }

  return sections.filter((s) => s.trim() !== '');
}

/**
 * Scores a section by the number of times the query keywords appear in it.
 */
function scoreSection(section: string, keywords: string[]): number {
  const lower = section.toLowerCase();
  let score = 0;
  for (const kw of keywords) {
    const regex = new RegExp(kw.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g');
    score += (lower.match(regex) ?? []).length;
  }
  return score;
}

/**
 * Simple keyword search across all three memory files.
 * Splits each file into ## sections, scores by keyword matches, returns top N.
 * Default maxResults = 3.
 */
export function searchMemory(flowDir: string, query: string, maxResults = 3): string {
  const files = ['decisions.md', 'patterns.md', 'lessons.md'];
  const keywords = query.trim().split(/\s+/).filter(Boolean);

  const scored: Array<{ section: string; score: number }> = [];

  for (const filename of files) {
    const content = readMemoryFile(flowDir, filename);
    if (!content) continue;

    for (const section of splitIntoSections(content)) {
      const score = scoreSection(section, keywords);
      if (score > 0) {
        scored.push({ section, score });
      }
    }
  }

  scored.sort((a, b) => b.score - a.score);

  return scored
    .slice(0, maxResults)
    .map((s) => s.section)
    .join('\n');
}

// ─── writeBackMemory ──────────────────────────────────────────────────────────

/**
 * Extracts a section from markdown text identified by an H2 heading.
 * Returns the section body (text between the heading and the next H2), or null.
 */
function extractSection(text: string, heading: string): string | null {
  const lines = text.split('\n');
  const headingLine = `## ${heading}`;
  const start = lines.findIndex((l) => l.trim() === headingLine);
  if (start === -1) return null;

  // Find next ## heading after start
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (lines[i]?.startsWith('## ')) {
      end = i;
      break;
    }
  }

  const body = lines
    .slice(start + 1, end)
    .join('\n')
    .trim();
  return body || null;
}

/**
 * Reads ship-log.md from featureDir, extracts Decisions / Patterns / Lessons
 * sections, and appends each to the respective memory file in flowDir.
 * Called by the extension after Shipper completes.
 */
export function writeBackMemory(flowDir: string, featureDir: string): void {
  const shipLogPath = path.join(featureDir, 'ship-log.md');
  if (!fs.existsSync(shipLogPath)) return;

  const shipLog = fs.readFileSync(shipLogPath, 'utf8');
  const featureName = path.basename(featureDir);
  const today = new Date().toISOString().slice(0, 10);

  const decisionsBody = extractSection(shipLog, 'Decisions');
  const patternsBody = extractSection(shipLog, 'Patterns');
  const lessonsBody = extractSection(shipLog, 'Lessons');

  if (decisionsBody) {
    const memDir = ensureMemoryDir(flowDir);
    const entry = [`\n## ${featureName} — ${today}`, decisionsBody, '---', ''].join('\n');
    fs.appendFileSync(path.join(memDir, 'decisions.md'), entry, 'utf8');
  }

  if (patternsBody) {
    const memDir = ensureMemoryDir(flowDir);
    const entry = [`\n## ${featureName} — first seen ${today}`, patternsBody, '---', ''].join('\n');
    fs.appendFileSync(path.join(memDir, 'patterns.md'), entry, 'utf8');
  }

  if (lessonsBody) {
    const memDir = ensureMemoryDir(flowDir);
    const entry = [`\n## ${featureName} — ${today}`, lessonsBody, '---', ''].join('\n');
    fs.appendFileSync(path.join(memDir, 'lessons.md'), entry, 'utf8');
  }
}
