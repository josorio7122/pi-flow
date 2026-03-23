import * as fs from 'node:fs';
import * as path from 'node:path';
import type { FlowConfig } from './types.js';

const DEFAULT_CONFIG: FlowConfig = {
  concurrency: { max_parallel: 8, max_workers: 4, stagger_ms: 150 },
  guardrails: {
    token_cap_per_agent: 100000,
    cost_cap_per_agent_usd: 10.0,
    scope_creep_warning: 0.20,
    scope_creep_halt: 0.30,
    loop_detection_window: 10,
    loop_detection_threshold: 3,
    analysis_paralysis_threshold: 8,
    git_watchdog_warn_minutes: 15,
    git_watchdog_halt_minutes: 30,
  },
  memory: { enabled: true },
  git: { branch_prefix: 'feature/', commit_style: 'conventional', auto_pr: true },
};

/**
 * Parses a scalar YAML value string into a JS primitive.
 * Handles booleans, numbers, and strings (with or without quotes).
 */
function parseScalar(raw: string): string | number | boolean {
  const s = raw.trim();
  if (s === 'true') return true;
  if (s === 'false') return false;
  if (s === 'null' || s === '~') return '' as unknown as string; // treat null as empty
  const n = Number(s);
  if (!Number.isNaN(n) && s !== '') return n;
  // Strip surrounding quotes (single or double)
  if (
    (s.startsWith('"') && s.endsWith('"')) ||
    (s.startsWith("'") && s.endsWith("'"))
  ) {
    return s.slice(1, -1);
  }
  return s;
}

/**
 * Minimal two-level YAML parser for pi-flow's config.yaml.
 * Parses sections (top-level keys) and their scalar key-value children.
 * Does not support arrays, multi-line values, or deeper nesting.
 *
 * Returns a plain object or throws on unrecoverable parse errors.
 */
function parseSimpleYaml(content: string): Record<string, Record<string, unknown>> {
  const result: Record<string, Record<string, unknown>> = {};
  let currentSection: string | null = null;

  for (const rawLine of content.split('\n')) {
    // Strip inline comments and trailing whitespace
    const commentIdx = rawLine.indexOf(' #');
    const line = commentIdx >= 0 ? rawLine.slice(0, commentIdx) : rawLine;
    const trimmed = line.trimEnd();

    if (trimmed === '' || trimmed.trimStart().startsWith('#')) continue;

    const indent = trimmed.length - trimmed.trimStart().length;

    if (indent === 0) {
      // Top-level key (section header or scalar)
      const colonIdx = trimmed.indexOf(':');
      if (colonIdx === -1) continue;
      const key = trimmed.slice(0, colonIdx).trim();
      currentSection = key;
      if (!result[currentSection]) {
        result[currentSection] = {};
      }
    } else if (indent >= 2 && currentSection !== null) {
      // Nested key under current section
      const colonIdx = trimmed.trimStart().indexOf(':');
      if (colonIdx === -1) continue;
      const stripped = trimmed.trimStart();
      const key = stripped.slice(0, colonIdx).trim();
      const valuePart = stripped.slice(colonIdx + 1).trim();
      if (key && valuePart !== '') {
        result[currentSection][key] = parseScalar(valuePart);
      }
    }
  }

  return result;
}

/**
 * Deep-merges `override` into `base`, returning a new object.
 * Only merges keys that exist in `base` to prevent unknown keys from
 * corrupting the config structure.
 */
function mergeSection<T extends Record<string, unknown>>(base: T, override: Record<string, unknown>): T {
  const merged = { ...base };
  for (const key of Object.keys(base) as Array<keyof T>) {
    if (Object.prototype.hasOwnProperty.call(override, key as string)) {
      (merged as Record<string, unknown>)[key as string] = override[key as string];
    }
  }
  return merged;
}

/**
 * Loads config from `<cwd>/.flow/config.yaml`.
 * Returns defaults if the file does not exist or cannot be parsed.
 */
export function loadConfig(cwd: string): FlowConfig {
  const configPath = path.join(cwd, '.flow', 'config.yaml');

  if (!fs.existsSync(configPath)) {
    return getDefaultConfig();
  }

  try {
    const content = fs.readFileSync(configPath, 'utf8');
    const parsed = parseSimpleYaml(content);
    const defaults = getDefaultConfig();

    return {
      concurrency: parsed.concurrency
        ? mergeSection(defaults.concurrency, parsed.concurrency)
        : defaults.concurrency,
      guardrails: parsed.guardrails
        ? mergeSection(defaults.guardrails, parsed.guardrails)
        : defaults.guardrails,
      memory: parsed.memory
        ? mergeSection(defaults.memory, parsed.memory)
        : defaults.memory,
      git: parsed.git
        ? mergeSection(defaults.git, parsed.git)
        : defaults.git,
    };
  } catch {
    return getDefaultConfig();
  }
}

export function getDefaultConfig(): FlowConfig {
  return structuredClone(DEFAULT_CONFIG);
}
