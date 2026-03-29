import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { initWorkflowDir } from "./store.js";
import { blockTask, completeTask, createTask, getReadyTasks, getTask, getTasks } from "./task-store.js";

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
    createTask({ cwd: tmpDir, workflowId: WF_ID, input: { id: "task-1", title: "First task", dependsOn: [] } });
    const task = getTask({ cwd: tmpDir, workflowId: WF_ID, taskId: "task-1" });
    expect(task).not.toBeNull();
    expect(task?.title).toBe("First task");
    expect(task?.status).toBe("todo");
    expect(task?.attemptCount).toBe(0);
  });

  it("returns null for missing task", () => {
    expect(getTask({ cwd: tmpDir, workflowId: WF_ID, taskId: "nonexistent" })).toBeNull();
  });

  it("returns null for structurally invalid task JSON", () => {
    const dir = path.join(tmpDir, ".pi", "flow", WF_ID, "tasks");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "bad-task.json"), JSON.stringify({ notATask: true }));
    expect(getTask({ cwd: tmpDir, workflowId: WF_ID, taskId: "bad-task" })).toBeNull();
  });
});

describe("getTasks", () => {
  it("lists all tasks", () => {
    createTask({ cwd: tmpDir, workflowId: WF_ID, input: { id: "task-1", title: "A", dependsOn: [] } });
    createTask({ cwd: tmpDir, workflowId: WF_ID, input: { id: "task-2", title: "B", dependsOn: ["task-1"] } });
    const tasks = getTasks({ cwd: tmpDir, workflowId: WF_ID });
    expect(tasks).toHaveLength(2);
  });
});

describe("getReadyTasks", () => {
  it("returns tasks with no dependencies", () => {
    createTask({ cwd: tmpDir, workflowId: WF_ID, input: { id: "task-1", title: "A", dependsOn: [] } });
    createTask({ cwd: tmpDir, workflowId: WF_ID, input: { id: "task-2", title: "B", dependsOn: ["task-1"] } });
    const ready = getReadyTasks({ cwd: tmpDir, workflowId: WF_ID });
    expect(ready).toHaveLength(1);
    expect(ready[0]?.id).toBe("task-1");
  });

  it("unblocks dependent tasks when dependency completes", () => {
    createTask({ cwd: tmpDir, workflowId: WF_ID, input: { id: "task-1", title: "A", dependsOn: [] } });
    createTask({ cwd: tmpDir, workflowId: WF_ID, input: { id: "task-2", title: "B", dependsOn: ["task-1"] } });
    completeTask({ cwd: tmpDir, workflowId: WF_ID, taskId: "task-1", summary: "done" });
    const ready = getReadyTasks({ cwd: tmpDir, workflowId: WF_ID });
    expect(ready).toHaveLength(1);
    expect(ready[0]?.id).toBe("task-2");
  });
});

describe("completeTask", () => {
  it("marks task as done with summary", () => {
    createTask({ cwd: tmpDir, workflowId: WF_ID, input: { id: "task-1", title: "A", dependsOn: [] } });
    completeTask({ cwd: tmpDir, workflowId: WF_ID, taskId: "task-1", summary: "all good" });
    const task = getTask({ cwd: tmpDir, workflowId: WF_ID, taskId: "task-1" });
    expect(task?.status).toBe("done");
    expect(task?.summary).toBe("all good");
  });
});

describe("blockTask", () => {
  it("marks task as blocked with reason", () => {
    createTask({ cwd: tmpDir, workflowId: WF_ID, input: { id: "task-1", title: "A", dependsOn: [] } });
    blockTask({ cwd: tmpDir, workflowId: WF_ID, taskId: "task-1", reason: "missing dependency" });
    const task = getTask({ cwd: tmpDir, workflowId: WF_ID, taskId: "task-1" });
    expect(task?.status).toBe("blocked");
    expect(task?.blockedReason).toBe("missing dependency");
  });
});
