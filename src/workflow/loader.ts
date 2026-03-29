/**
 * Discover and parse workflow .md files.
 * Same pattern as agents/custom.ts — .md with YAML frontmatter.
 *
 * Discovery hierarchy (higher priority wins by name):
 *   1. Project:  <cwd>/.pi/workflows/*.md
 *   2. Global:   ~/.pi/agent/workflows/*.md
 *   3. Built-in: <extension>/workflows/*.md
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { parseFrontmatter } from "@mariozechner/pi-coding-agent";
import type { PhaseDefinition, PhaseMode, WorkflowDefinition } from "./types.js";

export function loadWorkflowDefinitions(cwd: string, builtinDir?: string) {
  const workflows = new Map<string, WorkflowDefinition>();

  if (builtinDir) {
    mergeInto(workflows, loadWorkflowsFromDir(builtinDir, "builtin"));
  }

  const globalDir = join(homedir(), ".pi", "agent", "workflows");
  mergeInto(workflows, loadWorkflowsFromDir(globalDir, "global"));

  const projectDir = join(cwd, ".pi", "workflows");
  mergeInto(workflows, loadWorkflowsFromDir(projectDir, "project"));

  return workflows;
}

function mergeInto(target: Map<string, WorkflowDefinition>, source: Map<string, WorkflowDefinition>) {
  for (const [name, def] of source) {
    target.set(name, def);
  }
}

export function loadWorkflowsFromDir(dir: string, source: WorkflowDefinition["source"]) {
  const workflows = new Map<string, WorkflowDefinition>();
  if (!existsSync(dir)) return workflows;

  let files: string[];
  try {
    files = readdirSync(dir).filter((f) => f.endsWith(".md"));
  } catch {
    return workflows;
  }

  for (const file of files) {
    let content: string;
    try {
      content = readFileSync(join(dir, file), "utf-8");
    } catch {
      continue;
    }

    const def = parseWorkflowFile(content, basename(file, ".md"), source);
    if (def) {
      workflows.set(def.name, def);
    }
  }

  return workflows;
}

function parseWorkflowFile(
  content: string,
  fallbackName: string,
  source: WorkflowDefinition["source"],
): WorkflowDefinition | null {
  const { frontmatter: fm, body } = parseFrontmatter<Record<string, unknown>>(content);

  const name = typeof fm.name === "string" ? fm.name : fallbackName;
  const description = typeof fm.description === "string" ? fm.description : name;

  const triggers = parseStringArray(fm.triggers);
  const phases = parsePhases(fm.phases);
  if (phases.length === 0) return null;

  const config = parseConfig(fm.config);

  return {
    name,
    description,
    triggers,
    phases,
    config,
    orchestratorInstructions: body.trim(),
    source,
  };
}

// ── Parsers ──────────────────────────────────────────────────────────

function parseStringArray(val: unknown): string[] {
  if (!Array.isArray(val)) return [];
  return val.filter((v): v is string => typeof v === "string");
}

const VALID_MODES = new Set<PhaseMode>(["single", "parallel", "gate", "review-loop"]);

function parsePhases(val: unknown): PhaseDefinition[] {
  if (!Array.isArray(val)) return [];
  const phases: PhaseDefinition[] = [];

  for (const item of val) {
    if (typeof item !== "object" || item === null) continue;
    const raw = item as Record<string, unknown>;

    const name = typeof raw.name === "string" ? raw.name : undefined;
    const mode =
      typeof raw.mode === "string" && VALID_MODES.has(raw.mode as PhaseMode) ? (raw.mode as PhaseMode) : undefined;
    const description = typeof raw.description === "string" ? raw.description : "";

    if (!name || !mode) continue;

    phases.push({
      name,
      role: typeof raw.role === "string" ? raw.role : undefined,
      mode,
      description,
      contextFrom: typeof raw.contextFrom === "string" ? raw.contextFrom : undefined,
      fixRole: typeof raw.fixRole === "string" ? raw.fixRole : undefined,
      maxCycles: typeof raw.maxCycles === "number" ? raw.maxCycles : undefined,
      taskSource: typeof raw.taskSource === "string" ? raw.taskSource : undefined,
    });
  }

  return phases;
}

function parseConfig(val: unknown) {
  const defaults = { tokenLimit: 100_000 };
  if (typeof val !== "object" || val === null) return defaults;
  const raw = val as Record<string, unknown>;

  return {
    tokenLimit: typeof raw.tokenLimit === "number" ? raw.tokenLimit : defaults.tokenLimit,
    maxTurnsPerAgent: typeof raw.maxTurnsPerAgent === "number" ? raw.maxTurnsPerAgent : undefined,
  };
}
