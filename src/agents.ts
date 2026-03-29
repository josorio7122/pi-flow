import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { execSync } from 'node:child_process';
import type { FlowAgentConfig } from './types.js';

// ─── Scalar parser ────────────────────────────────────────────────────────────

function parseScalar(raw: string): unknown {
  const s = raw.trim();
  if (s === 'true') return true;
  if (s === 'false') return false;
  if (s === 'null' || s === '~') return null;
  const n = Number(s);
  if (!Number.isNaN(n) && s !== '') return n;
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    return s.slice(1, -1);
  }
  return s;
}

// ─── Agent frontmatter parser ─────────────────────────────────────────────────
//
// Handles the full YAML subset used in agent .md files:
//   - Simple scalars:          name: builder
//   - Folded strings:          description: >
//                                Line 1.
//   - YAML lists:              tools:
//                                - read
//   - Nested objects:          limits:
//                                max_tokens: 100000

function parseAgentFrontmatterRaw(content: string): Record<string, unknown> {
  const lines = content.split('\n');
  if (lines[0]?.trim() !== '---') return {};

  let end = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i]?.trim() === '---') {
      end = i;
      break;
    }
  }
  if (end === -1) return {};

  const fmLines = lines.slice(1, end);
  const result: Record<string, unknown> = {};

  let i = 0;
  while (i < fmLines.length) {
    const line = fmLines[i];
    if (line === undefined) {
      i++;
      continue;
    }

    // Skip empty lines and comment lines at top level
    if (line.trim() === '' || line.trimStart().startsWith('#')) {
      i++;
      continue;
    }

    const indent = line.length - line.trimStart().length;

    // Only process top-level keys (indent === 0)
    if (indent > 0) {
      i++;
      continue;
    }

    const colonIdx = line.indexOf(':');
    if (colonIdx === -1) {
      i++;
      continue;
    }

    const key = line.slice(0, colonIdx).trim();
    const rawValue = line.slice(colonIdx + 1).trim();

    if (!key) {
      i++;
      continue;
    }

    if (rawValue === '' || rawValue === '>' || rawValue === '|') {
      // Multi-line value: collect subsequent indented lines
      const nextLines: Array<{ content: string; indent: number }> = [];
      let j = i + 1;
      while (j < fmLines.length) {
        const nextLine = fmLines[j];
        if (nextLine === undefined) {
          j++;
          continue;
        }
        if (nextLine.trim() === '') {
          j++;
          continue;
        } // skip blank lines
        const nextIndent = nextLine.length - nextLine.trimStart().length;
        if (nextIndent === 0) break; // back to top-level: stop
        nextLines.push({ content: nextLine.trimStart(), indent: nextIndent });
        j++;
      }

      if (nextLines.length === 0) {
        // Nothing follows — empty value
        result[key] = '';
        i++;
      } else if (nextLines[0].content.startsWith('- ')) {
        // YAML list
        result[key] = nextLines
          .filter((nl) => nl.content.startsWith('- '))
          .map((nl) => nl.content.slice(2).trim());
        i = j;
      } else if (rawValue === '>' || rawValue === '|') {
        // Folded (>) or literal (|) block scalar
        const joiner = rawValue === '>' ? ' ' : '\n';
        result[key] = nextLines
          .map((nl) => nl.content)
          .join(joiner)
          .trim();
        i = j;
      } else {
        // Nested object (key: value pairs under indentation)
        const nested: Record<string, unknown> = {};
        for (const nl of nextLines) {
          const nc = nl.content.indexOf(':');
          if (nc === -1) continue;
          const nk = nl.content.slice(0, nc).trim();
          const nv = nl.content.slice(nc + 1).trim();
          if (nk && nv !== '') {
            nested[nk] = parseScalar(nv);
          }
        }
        result[key] = nested;
        i = j;
      }
    } else {
      // Simple scalar (could be comma-separated string)
      result[key] = parseScalar(rawValue);
      i++;
    }
  }

  return result;
}

// ─── Body extractor ───────────────────────────────────────────────────────────

function extractBody(content: string): string {
  const lines = content.split('\n');
  if (lines[0]?.trim() !== '---') return content;
  let end = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i]?.trim() === '---') {
      end = i;
      break;
    }
  }
  if (end === -1) return content;
  return lines.slice(end + 1).join('\n');
}

// ─── List coercion ────────────────────────────────────────────────────────────
//
// Handles both YAML list (already an array) and comma-separated string.

function toStringArray(val: unknown): string[] {
  if (Array.isArray(val)) return val.map(String);
  if (typeof val === 'string' && val.includes(',')) {
    return val
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
  }
  if (typeof val === 'string' && val.trim()) return [val.trim()];
  return [];
}

// ─── extractSection ───────────────────────────────────────────────────────────

/**
 * Extracts the content of a markdown section identified by its heading.
 * The heading must include the `##` prefix (e.g. `"## Goal"`).
 * Returns everything from the heading until the next `##` heading (or EOF),
 * trimmed of leading/trailing whitespace.
 *
 * Returns an empty string if the heading is not found.
 */
export function extractSection(content: string, heading: string): string {
  // Escape special regex chars in the heading
  const escaped = heading.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(`^${escaped}\\s*$`, 'm');
  const match = pattern.exec(content);
  if (!match) return '';

  const start = match.index + match[0].length;
  const rest = content.slice(start);
  const nextHeadingIdx = rest.search(/^## /m);
  const end = nextHeadingIdx >= 0 ? start + nextHeadingIdx : content.length;
  return content.slice(start, end).trim();
}

// ─── parseAgentFile ───────────────────────────────────────────────────────────

/**
 * Reads an agent `.md` file, parses the YAML frontmatter, and returns a
 * `FlowAgentConfig`. The markdown body (after the closing `---`) becomes the
 * `systemPrompt`.
 *
 * Handles:
 * - Tools/variables/writes as either YAML list or comma-separated string
 * - Nested `limits:` object with `max_tokens` and `max_steps`
 * - Folded description strings (`description: >`)
 */
export function parseAgentFile(filePath: string, source: 'builtin' | 'custom'): FlowAgentConfig {
  const raw = fs.readFileSync(filePath, 'utf8');
  const fm = parseAgentFrontmatterRaw(raw);
  const body = extractBody(raw);

  const tools = toStringArray(fm.tools);
  const variables = toStringArray(fm.variables);
  const writes = toStringArray(fm.writes);

  const limitsRaw = fm.limits as Record<string, unknown> | undefined;
  const memoryRaw = fm.memory as string | undefined;
  const memory = memoryRaw === 'project' || memoryRaw === 'global' ? memoryRaw : undefined;

  return {
    name: String(fm.name ?? ''),
    label: String(fm.label ?? fm.name ?? ''),
    description: String(fm.description ?? ''),
    model: String(fm.model ?? ''),
    thinking: String(fm.thinking ?? 'medium'),
    tools,
    writable: fm.writable === true,
    limits: {
      max_tokens: Number(limitsRaw?.max_tokens ?? 0),
      max_steps: Number(limitsRaw?.max_steps ?? 0),
    },
    variables,
    writes,
    systemPrompt: body.trim(),
    source,
    filePath,
    memory,
  };
}

// ─── validateAgent ────────────────────────────────────────────────────────────

const ALLOWED_TOOLS = new Set(['read', 'write', 'edit', 'bash', 'grep', 'find', 'ls']);

/**
 * Validates a `FlowAgentConfig` and returns an array of error messages.
 * An empty array means the agent is valid.
 *
 * Checks:
 * - Required fields: name, model, tools
 * - Model must be a valid Claude model string (contains "claude")
 * - Tools must be from the allowed set
 * - If writable === false, write and edit are not permitted in tools
 */
export function validateAgent(agent: FlowAgentConfig): string[] {
  const errors: string[] = [];

  if (!agent.name) errors.push('missing required field: name');
  if (!agent.model) errors.push('missing required field: model');
  if (!agent.tools || agent.tools.length === 0) errors.push('missing required field: tools');

  // Validate model is a Claude model
  if (agent.model && !agent.model.toLowerCase().includes('claude')) {
    errors.push(
      `invalid model: "${agent.model}" — must be a valid Claude model (e.g. claude-sonnet-4-6)`,
    );
  }

  // Validate each tool is from the allowed set
  for (const tool of agent.tools) {
    if (!ALLOWED_TOOLS.has(tool)) {
      errors.push(`unknown tool: "${tool}" — allowed tools: ${[...ALLOWED_TOOLS].join(', ')}`);
    }
  }

  // When writable is false, write and edit must not be in tools
  if (agent.writable === false) {
    if (agent.tools.includes('write')) {
      errors.push('tool "write" is not allowed when writable is false');
    }
    if (agent.tools.includes('edit')) {
      errors.push('tool "edit" is not allowed when writable is false');
    }
  }

  return errors;
}

// ─── discoverAgents ───────────────────────────────────────────────────────────

/**
 * Discovers all agents available to the workflow:
 *
 * 1. Loads built-in agents from `<extensionDir>/agents/*.md`
 * 2. Loads custom agents from `.flow/agents/custom/*.md` (walks up from cwd)
 * 3. Merges the two sets — custom overrides built-in by name
 *
 * Returns the merged list of `FlowAgentConfig`.
 */
export function discoverAgents(extensionDir: string, cwd: string): FlowAgentConfig[] {
  const builtinDir = path.join(extensionDir, 'agents');
  const builtins = loadAgentsFromDir(builtinDir, 'builtin');

  const customDir = findCustomAgentsDir(cwd);
  const customs = customDir ? loadAgentsFromDir(customDir, 'custom') : [];

  // Custom overrides built-in by name (last write wins)
  const agentMap = new Map<string, FlowAgentConfig>();
  for (const a of builtins) agentMap.set(a.name, a);
  for (const a of customs) agentMap.set(a.name, a);

  return Array.from(agentMap.values());
}

function loadAgentsFromDir(dir: string, source: 'builtin' | 'custom'): FlowAgentConfig[] {
  if (!fs.existsSync(dir)) return [];
  let files: string[];
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith('.md'));
  } catch {
    return [];
  }

  const agents: FlowAgentConfig[] = [];
  for (const file of files) {
    try {
      agents.push(parseAgentFile(path.join(dir, file), source));
    } catch {
      // Skip unreadable or malformed agent files
    }
  }
  return agents;
}

/**
 * Walks up the directory tree from `cwd` looking for `.flow/agents/custom/`.
 * Returns the path to the first such directory found, or null if none exists.
 */
function findCustomAgentsDir(cwd: string): string | null {
  let dir = cwd;
  while (true) {
    const candidate = path.join(dir, '.flow', 'agents', 'custom');
    if (fs.existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) return null; // reached filesystem root
    dir = parent;
  }
}

// ─── readAgentsMd ─────────────────────────────────────────────────────────────

/**
 * Reads AGENTS.md from both the global location (`~/.pi/agent/AGENTS.md`) and
 * the project location (`./AGENTS.md` or `./.pi/agent/AGENTS.md`).
 *
 * Per §14 S3: both are concatenated with a separator, project rules come after
 * global rules (project overrides global). The first project path found wins.
 *
 * Returns the combined content, or an empty string if neither file exists.
 */
export function readAgentsMd(cwd: string): string {
  const parts: string[] = [];

  // 1. Global AGENTS.md
  const globalPath = path.join(os.homedir(), '.pi', 'agent', 'AGENTS.md');
  if (fs.existsSync(globalPath)) {
    parts.push(`<!-- Global AGENTS.md -->\n${fs.readFileSync(globalPath, 'utf8')}`);
  }

  // 2. Project AGENTS.md (first match wins)
  const projectPaths = [path.join(cwd, 'AGENTS.md'), path.join(cwd, '.pi', 'agent', 'AGENTS.md')];
  for (const p of projectPaths) {
    if (fs.existsSync(p)) {
      parts.push(`<!-- Project AGENTS.md -->\n${fs.readFileSync(p, 'utf8')}`);
      break;
    }
  }

  return parts.join('\n\n---\n\n');
}

// ─── buildVariableMap ─────────────────────────────────────────────────────────

/**
 * Builds the complete variable map for injecting into agent system prompts.
 *
 * Reads from the feature directory's artifact files (spec.md, design.md,
 * tasks.md) and cross-feature memory files
 * (.flow/memory/decisions.md, patterns.md, lessons.md).
 *
 * Per §13 B8 (canonical variable table) and §14 S3 (AGENTS_MD variable).
 */
export function buildVariableMap(cwd: string, featureDir: string): Record<string, string> {
  const featureName = path.basename(featureDir);
  const memoryDir = path.join(cwd, '.flow', 'memory');

  const safeRead = (filePath: string): string => {
    try {
      return fs.readFileSync(filePath, 'utf8');
    } catch {
      return '';
    }
  };

  const specContent = safeRead(path.join(featureDir, 'spec.md'));
  const designContent = safeRead(path.join(featureDir, 'design.md'));
  const tasksContent = safeRead(path.join(featureDir, 'tasks.md'));
  const analysisContent = safeRead(path.join(featureDir, 'analysis.md'));

  return {
    FEATURE_NAME: featureName,
    FEATURE_DIR: featureDir,
    AGENTS_MD: readAgentsMd(cwd),

    // Spec variables
    SPEC_GOAL: extractSection(specContent, '## Goal'),
    SPEC_BEHAVIORS: extractSection(specContent, '## Behaviors'),
    SPEC_ERROR_CASES: extractSection(specContent, '## Error Cases'),

    // Design variables
    CHOSEN_APPROACH: extractSection(designContent, '## Decision'),
    DESIGN_SUMMARY: extractSection(designContent, '## Decision'),

    // Tasks
    WAVE_TASKS: tasksContent,

    // Analysis
    ANALYSIS_SUMMARY: analysisContent,

    // Memory
    MEMORY_DECISIONS: safeRead(path.join(memoryDir, 'decisions.md')),
    MEMORY_PATTERNS: safeRead(path.join(memoryDir, 'patterns.md')),
    MEMORY_LESSONS: safeRead(path.join(memoryDir, 'lessons.md')),

    // Git
    BASE_BRANCH: detectBaseBranch(cwd),
  };
}

function detectBaseBranch(cwd: string): string {
  try {
    execSync('git rev-parse --verify main', { cwd, stdio: 'pipe' });
    return 'main';
  } catch {
    try {
      execSync('git rev-parse --verify master', { cwd, stdio: 'pipe' });
      return 'master';
    } catch {
      return 'main';
    }
  }
}

// ─── injectVariables ──────────────────────────────────────────────────────────

/**
 * Injects variable values into a prompt template by replacing `{{VAR}}` placeholders.
 *
 * Only variables listed in `agentVariables` are replaced. Any `{{VAR}}` that is
 * NOT in `agentVariables` is left unchanged in the prompt.
 *
 * If a variable is declared in `agentVariables` but has no entry in `variableMap`,
 * it is replaced with an empty string and a warning is logged to stderr.
 */
export function injectVariables(
  prompt: string,
  variableMap: Record<string, string>,
  agentVariables: string[],
): string {
  let result = prompt;

  for (const varName of agentVariables) {
    const placeholder = `{{${varName}}}`;
    if (varName in variableMap) {
      result = result.replaceAll(placeholder, variableMap[varName]);
    } else {
      // Variable declared but missing from map: replace with empty + warn
      console.warn(
        `[pi-flow] Variable {{${varName}}} declared in agent variables but not found in variable map`,
      );
      result = result.replaceAll(placeholder, '');
    }
  }

  return result;
}
