import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadWorkflowsFromDir } from "./loader.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "pi-flow-loader-"));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

const RESEARCH_MD = `---
name: research
description: Research or verify something
triggers:
  - research, look up information
  - query databases
phases:
  - name: probe
    role: probe
    mode: single
    description: Research the question
---

Extra orchestrator instructions here.
`;

const FIX_MD = `---
name: fix
description: Scout and fix issues
triggers:
  - fix patterns in codebase
phases:
  - name: scout
    role: scout
    mode: single
    description: Scan codebase
  - name: approve
    mode: gate
    description: User approves
  - name: build
    role: builder
    mode: single
    description: Fix issues
    contextFrom: scout
  - name: review
    role: reviewer
    mode: review-loop
    description: Check changes
    fixRole: builder
    maxCycles: 3
---
`;

describe("loadWorkflowsFromDir", () => {
  it("loads workflow definitions from .md files", () => {
    writeFileSync(join(tmpDir, "research.md"), RESEARCH_MD);
    const workflows = loadWorkflowsFromDir(tmpDir, "builtin");
    expect(workflows.size).toBe(1);
    const w = workflows.get("research");
    expect(w).toBeDefined();
    expect(w?.description).toBe("Research or verify something");
    expect(w?.triggers).toEqual(["research, look up information", "query databases"]);
    expect(w?.phases).toHaveLength(1);
    expect(w?.phases[0]?.mode).toBe("single");
    expect(w?.orchestratorInstructions).toBe("Extra orchestrator instructions here.");
    expect(w?.source).toBe("builtin");
  });

  it("parses complex workflow with multiple phases", () => {
    writeFileSync(join(tmpDir, "fix.md"), FIX_MD);
    const workflows = loadWorkflowsFromDir(tmpDir, "builtin");
    const w = workflows.get("fix");
    expect(w?.phases).toHaveLength(4);
    expect(w?.phases[1]?.mode).toBe("gate");
    expect(w?.phases[1]?.role).toBeUndefined();
    expect(w?.phases[3]?.mode).toBe("review-loop");
    expect(w?.phases[3]?.fixRole).toBe("builder");
    expect(w?.phases[3]?.maxCycles).toBe(3);
    expect(w?.phases[2]?.contextFrom).toBe("scout");
  });

  it("returns empty map for nonexistent directory", () => {
    const workflows = loadWorkflowsFromDir("/nonexistent/path", "builtin");
    expect(workflows.size).toBe(0);
  });

  it("skips non-.md files", () => {
    writeFileSync(join(tmpDir, "notes.txt"), "not a workflow");
    writeFileSync(join(tmpDir, "research.md"), RESEARCH_MD);
    const workflows = loadWorkflowsFromDir(tmpDir, "builtin");
    expect(workflows.size).toBe(1);
  });
});
