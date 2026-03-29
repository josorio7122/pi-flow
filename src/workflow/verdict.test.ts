import { describe, expect, it } from "vitest";
import { parseVerdict } from "./verdict.js";

describe("parseVerdict", () => {
  it("parses SHIP verdict", () => {
    const output = `## Verdict: SHIP\n\nAll changes look good.\n\n## Suggestions\n- Consider adding more tests`;
    const result = parseVerdict(output);
    expect(result.verdict).toBe("SHIP");
    expect(result.summary).toBe("All changes look good.");
    expect(result.issues).toEqual([]);
    expect(result.suggestions).toEqual(["Consider adding more tests"]);
  });

  it("parses NEEDS_WORK verdict with issues", () => {
    const output = `## Verdict: NEEDS_WORK\n\nTwo problems found.\n\n## Issues\n- src/types.ts line 22: any still present\n- src/index.ts line 200: unused import\n\n## Suggestions\n- Use unknown instead of any`;
    const result = parseVerdict(output);
    expect(result.verdict).toBe("NEEDS_WORK");
    expect(result.summary).toBe("Two problems found.");
    expect(result.issues).toEqual(["src/types.ts line 22: any still present", "src/index.ts line 200: unused import"]);
    expect(result.suggestions).toEqual(["Use unknown instead of any"]);
  });

  it("parses MAJOR_RETHINK verdict", () => {
    const output = `## Verdict: MAJOR_RETHINK\n\nFundamental design issue.`;
    const result = parseVerdict(output);
    expect(result.verdict).toBe("MAJOR_RETHINK");
    expect(result.summary).toBe("Fundamental design issue.");
  });

  it("defaults to NEEDS_WORK when verdict is missing", () => {
    const result = parseVerdict("no verdict here");
    expect(result.verdict).toBe("NEEDS_WORK");
    expect(result.summary).toBe("");
    expect(result.issues).toEqual([]);
    expect(result.suggestions).toEqual([]);
  });

  it("handles case-insensitive verdict", () => {
    const result = parseVerdict("## Verdict: ship\n\nDone.");
    expect(result.verdict).toBe("SHIP");
  });

  it("parses issues with asterisk bullets", () => {
    const output = `## Verdict: NEEDS_WORK\n\nIssues found.\n\n## Issues\n* first issue\n* second issue`;
    const result = parseVerdict(output);
    expect(result.issues).toEqual(["first issue", "second issue"]);
  });
});
