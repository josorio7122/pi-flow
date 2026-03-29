/**
 * File I/O layer for workflow state, handoffs, and events.
 * The ONLY module that touches the filesystem.
 *
 * All writes are atomic (temp file + rename) to prevent corruption on crash.
 * All reads return null on missing/corrupt files.
 *
 * I/O helpers adapted from pi-messenger crew/store.ts.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { AgentHandoff, WorkflowEvent, WorkflowState } from "./types.js";

// ── Path Helpers ─────────────────────────────────────────────────────

const FLOW_ROOT = ".pi/flow";

export function getFlowDir(cwd: string, workflowId: string) {
  return path.join(cwd, FLOW_ROOT, workflowId);
}

function handoffsDir(cwd: string, workflowId: string) {
  return path.join(getFlowDir(cwd, workflowId), "handoffs");
}

function statePath(cwd: string, workflowId: string) {
  return path.join(getFlowDir(cwd, workflowId), "state.json");
}

function eventsPath(cwd: string, workflowId: string) {
  return path.join(getFlowDir(cwd, workflowId), "events.jsonl");
}

// ── Generic I/O ─────────────────────────────────────────────────────

function ensureDir(dir: string) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

/**
 * Read and parse a JSON file. Returns null if missing, unreadable, or not a JSON object/array.
 * The caller is responsible for further type narrowing — this only guarantees valid JSON.
 */
export function readJson<T>(filePath: string, guard?: (v: unknown) => v is T): T | null {
  if (!fs.existsSync(filePath)) return null;
  try {
    const raw: unknown = JSON.parse(fs.readFileSync(filePath, "utf-8"));
    if (guard) return guard(raw) ? raw : null;
    if (typeof raw !== "object" || raw === null) return null;
    return raw as T;
  } catch {
    return null;
  }
}

export function writeJson(filePath: string, data: unknown) {
  ensureDir(path.dirname(filePath));
  const temp = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(temp, JSON.stringify(data, null, 2));
  fs.renameSync(temp, filePath);
}

// ── Workflow Directory ───────────────────────────────────────────────

export function initWorkflowDir(cwd: string, workflowId: string) {
  const dir = getFlowDir(cwd, workflowId);
  ensureDir(dir);
  ensureDir(handoffsDir(cwd, workflowId));
}

// ── Guards ────────────────────────────────────────────────────────────

function isWorkflowState(val: unknown): val is WorkflowState {
  return typeof val === "object" && val !== null && "id" in val && "currentPhase" in val && "phases" in val;
}

function isAgentHandoff(val: unknown): val is AgentHandoff {
  return typeof val === "object" && val !== null && "agentId" in val && "role" in val && "phase" in val;
}

// ── State ────────────────────────────────────────────────────────────

export function readState({ cwd, workflowId }: { cwd: string; workflowId: string }) {
  return readJson<WorkflowState>(statePath(cwd, workflowId), isWorkflowState);
}

export function writeState({ cwd, workflowId, state }: { cwd: string; workflowId: string; state: WorkflowState }) {
  writeJson(statePath(cwd, workflowId), state);
}

// ── Handoffs ─────────────────────────────────────────────────────────

export function writeHandoff({ cwd, workflowId, handoff }: { cwd: string; workflowId: string; handoff: AgentHandoff }) {
  const dir = handoffsDir(cwd, workflowId);
  const existing = listHandoffFiles(dir);
  const num = existing.length + 1;
  const filename = `${String(num).padStart(3, "0")}-${handoff.role}.json`;
  writeJson(path.join(dir, filename), handoff);
  return filename;
}

export function listHandoffs({ cwd, workflowId }: { cwd: string; workflowId: string }) {
  const dir = handoffsDir(cwd, workflowId);
  const files = listHandoffFiles(dir);
  const handoffs: AgentHandoff[] = [];
  for (const file of files) {
    const h = readJson<AgentHandoff>(path.join(dir, file), isAgentHandoff);
    if (h) handoffs.push(h);
  }
  return handoffs;
}

function listHandoffFiles(dir: string) {
  if (!fs.existsSync(dir)) return [];
  try {
    return fs
      .readdirSync(dir)
      .filter((f) => f.endsWith(".json"))
      .sort();
  } catch {
    return [];
  }
}

// ── Events (JSONL) ───────────────────────────────────────────────────

export function appendEvent({ cwd, workflowId, event }: { cwd: string; workflowId: string; event: WorkflowEvent }) {
  const fp = eventsPath(cwd, workflowId);
  ensureDir(path.dirname(fp));
  fs.appendFileSync(fp, JSON.stringify(event) + "\n");
}

function isWorkflowEvent(val: unknown): val is WorkflowEvent {
  return (
    typeof val === "object" &&
    val !== null &&
    "type" in val &&
    typeof (val as Record<string, unknown>).type === "string"
  );
}

export function readEvents(cwd: string, workflowId: string) {
  const fp = eventsPath(cwd, workflowId);
  if (!fs.existsSync(fp)) return [];
  try {
    const content = fs.readFileSync(fp, "utf-8").trim();
    if (!content) return [];
    const events: WorkflowEvent[] = [];
    for (const line of content.split("\n")) {
      if (!line) continue;
      try {
        const parsed: unknown = JSON.parse(line);
        if (isWorkflowEvent(parsed)) events.push(parsed);
      } catch {
        // Skip malformed JSONL lines
      }
    }
    return events;
  } catch {
    return [];
  }
}
