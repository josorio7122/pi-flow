import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { initWorkflowDir } from "./store.js";
import { blockTask, completeTask, createTask, getReadyTasks, getTask, getTasks, resetTask } from "./task-store.js";

let tmpDir: string;
const WF_ID = "flow-tasks-test";

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-flow-tasks-"));
  initWorkflowDir(tmpDir, WF_ID);
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("createTask / getTask", () => {
  it("creates and retrieves a task", () => {
    createTask(tmpDir, WF_ID, { id: "task-1", title: "First task", dependsOn: [] });
    const task = getTask(tmpDir, WF_ID, "task-1");
    expect(task).not.toBeNull();
    expect(task?.title).toBe("First task");
    expect(task?.status).toBe("todo");
    expect(task?.attemptCount).toBe(0);
  });

  it("returns null for missing task", () => {
    expect(getTask(tmpDir, WF_ID, "nonexistent")).toBeNull();
  });
});

describe("getTasks", () => {
  it("lists all tasks", () => {
    createTask(tmpDir, WF_ID, { id: "task-1", title: "A", dependsOn: [] });
    createTask(tmpDir, WF_ID, { id: "task-2", title: "B", dependsOn: ["task-1"] });
    const tasks = getTasks(tmpDir, WF_ID);
    expect(tasks).toHaveLength(2);
  });
});

describe("getReadyTasks", () => {
  it("returns tasks with no dependencies", () => {
    createTask(tmpDir, WF_ID, { id: "task-1", title: "A", dependsOn: [] });
    createTask(tmpDir, WF_ID, { id: "task-2", title: "B", dependsOn: ["task-1"] });
    const ready = getReadyTasks(tmpDir, WF_ID);
    expect(ready).toHaveLength(1);
    expect(ready[0]?.id).toBe("task-1");
  });

  it("unblocks dependent tasks when dependency completes", () => {
    createTask(tmpDir, WF_ID, { id: "task-1", title: "A", dependsOn: [] });
    createTask(tmpDir, WF_ID, { id: "task-2", title: "B", dependsOn: ["task-1"] });
    completeTask({ cwd: tmpDir, workflowId: WF_ID, taskId: "task-1", summary: "done" });
    const ready = getReadyTasks(tmpDir, WF_ID);
    expect(ready).toHaveLength(1);
    expect(ready[0]?.id).toBe("task-2");
  });
});

describe("completeTask", () => {
  it("marks task as done with summary", () => {
    createTask(tmpDir, WF_ID, { id: "task-1", title: "A", dependsOn: [] });
    completeTask({ cwd: tmpDir, workflowId: WF_ID, taskId: "task-1", summary: "all good" });
    const task = getTask(tmpDir, WF_ID, "task-1");
    expect(task?.status).toBe("done");
    expect(task?.summary).toBe("all good");
  });
});

describe("blockTask", () => {
  it("marks task as blocked with reason", () => {
    createTask(tmpDir, WF_ID, { id: "task-1", title: "A", dependsOn: [] });
    blockTask({ cwd: tmpDir, workflowId: WF_ID, taskId: "task-1", reason: "missing dependency" });
    const task = getTask(tmpDir, WF_ID, "task-1");
    expect(task?.status).toBe("blocked");
    expect(task?.blockedReason).toBe("missing dependency");
  });
});

describe("resetTask", () => {
  it("resets a done task back to todo", () => {
    createTask(tmpDir, WF_ID, { id: "task-1", title: "A", dependsOn: [] });
    completeTask({ cwd: tmpDir, workflowId: WF_ID, taskId: "task-1", summary: "done" });
    resetTask(tmpDir, WF_ID, "task-1");
    const task = getTask(tmpDir, WF_ID, "task-1");
    expect(task?.status).toBe("todo");
    expect(task?.attemptCount).toBe(1);
  });
});
