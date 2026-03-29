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

export function readJson<T>(filePath: string): T | null {
  if (!fs.existsSync(filePath)) return null;
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf-8")) as T;
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

// ── State ────────────────────────────────────────────────────────────

export function readState(cwd: string, workflowId: string) {
  return readJson<WorkflowState>(statePath(cwd, workflowId));
}

export function writeState(cwd: string, workflowId: string, state: WorkflowState) {
  writeJson(statePath(cwd, workflowId), state);
}

export function updateState(cwd: string, workflowId: string, updater: (state: WorkflowState) => void) {
  const state = readState(cwd, workflowId);
  if (!state) return;
  updater(state);
  writeState(cwd, workflowId, state);
}

// ── Handoffs ─────────────────────────────────────────────────────────

export function writeHandoff(cwd: string, workflowId: string, handoff: AgentHandoff) {
  const dir = handoffsDir(cwd, workflowId);
  const existing = listHandoffFiles(dir);
  const num = existing.length + 1;
  const filename = `${String(num).padStart(3, "0")}-${handoff.role}.json`;
  writeJson(path.join(dir, filename), handoff);
  return filename;
}

export function readHandoff(cwd: string, workflowId: string, filename: string) {
  return readJson<AgentHandoff>(path.join(handoffsDir(cwd, workflowId), filename));
}

export function listHandoffs(cwd: string, workflowId: string) {
  const dir = handoffsDir(cwd, workflowId);
  const files = listHandoffFiles(dir);
  const handoffs: AgentHandoff[] = [];
  for (const file of files) {
    const h = readJson<AgentHandoff>(path.join(dir, file));
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

export function appendEvent(cwd: string, workflowId: string, event: WorkflowEvent) {
  const fp = eventsPath(cwd, workflowId);
  ensureDir(path.dirname(fp));
  fs.appendFileSync(fp, JSON.stringify(event) + "\n");
}

export function readEvents(cwd: string, workflowId: string) {
  const fp = eventsPath(cwd, workflowId);
  if (!fs.existsSync(fp)) return [];
  try {
    const content = fs.readFileSync(fp, "utf-8").trim();
    if (!content) return [];
    return content
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as WorkflowEvent);
  } catch {
    return [];
  }
}
