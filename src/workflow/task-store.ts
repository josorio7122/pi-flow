/**
 * Task CRUD with dependency resolution.
 * Each task is an individual JSON file — atomic per-task updates.
 *
 * Adapted from pi-messenger crew/store.ts task operations.
 */

import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { getFlowDir, readJson, writeJson } from "./store.js";
import type { Task } from "./types.js";

function isTask(val: unknown): val is Task {
  return typeof val === "object" && val !== null && "id" in val && "status" in val && "title" in val;
}

// ── Path Helpers ─────────────────────────────────────────────────────

function tasksDir(cwd: string, workflowId: string) {
  return join(getFlowDir(cwd, workflowId), "tasks");
}

function taskPath({ cwd, workflowId, taskId }: { cwd: string; workflowId: string; taskId: string }) {
  return join(tasksDir(cwd, workflowId), `${taskId}.json`);
}

// ── CRUD ─────────────────────────────────────────────────────────────

export function createTask({
  cwd,
  workflowId,
  input,
}: {
  cwd: string;
  workflowId: string;
  input: { id: string; title: string; dependsOn: readonly string[] };
}) {
  const now = new Date().toISOString();
  const task: Task = {
    id: input.id,
    title: input.title,
    status: "todo",
    dependsOn: input.dependsOn,
    createdAt: now,
    updatedAt: now,
    attemptCount: 0,
  };
  writeJson(taskPath({ cwd, workflowId, taskId: input.id }), task);
  return task;
}

export function getTask({ cwd, workflowId, taskId }: { cwd: string; workflowId: string; taskId: string }) {
  return readJson<Task>(taskPath({ cwd, workflowId, taskId }), isTask);
}

export function getTasks({ cwd, workflowId }: { cwd: string; workflowId: string }) {
  const dir = tasksDir(cwd, workflowId);
  if (!existsSync(dir)) return [];
  try {
    const files = readdirSync(dir).filter((f) => f.endsWith(".json"));
    const tasks: Task[] = [];
    for (const file of files) {
      const task = readJson<Task>(join(dir, file), isTask);
      if (task) tasks.push(task);
    }
    return tasks;
  } catch {
    return [];
  }
}

/** Find tasks whose dependencies are all done. */
export function getReadyTasks({ cwd, workflowId }: { cwd: string; workflowId: string }) {
  const tasks = getTasks({ cwd, workflowId });
  const doneIds = new Set(tasks.filter((t) => t.status === "done").map((t) => t.id));
  return tasks.filter((task) => task.status === "todo" && task.dependsOn.every((dep) => doneIds.has(dep)));
}

// ── State Transitions ────────────────────────────────────────────────

function updateTask({
  cwd,
  workflowId,
  taskId,
  updates,
}: {
  cwd: string;
  workflowId: string;
  taskId: string;
  updates: Partial<Task>;
}) {
  const task = getTask({ cwd, workflowId, taskId });
  if (!task) return null;
  const updated = { ...task, ...updates, updatedAt: new Date().toISOString() };
  writeJson(taskPath({ cwd, workflowId, taskId }), updated);
  return updated;
}

export function completeTask({
  cwd,
  workflowId,
  taskId,
  summary,
}: {
  cwd: string;
  workflowId: string;
  taskId: string;
  summary: string;
}) {
  return updateTask({ cwd, workflowId, taskId, updates: { status: "done", summary } });
}

export function blockTask({
  cwd,
  workflowId,
  taskId,
  reason,
}: {
  cwd: string;
  workflowId: string;
  taskId: string;
  reason: string;
}) {
  return updateTask({ cwd, workflowId, taskId, updates: { status: "blocked", blockedReason: reason } });
}
