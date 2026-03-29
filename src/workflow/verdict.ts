/**
 * Parse reviewer agent markdown output into structured verdict.
 */

import type { ParsedReview, ReviewVerdict } from "./types.js";

export function parseVerdict(output: string) {
  const result: ParsedReview = {
    verdict: "NEEDS_WORK",
    summary: "",
    issues: [],
    suggestions: [],
  };

  const verdictMatch = output.match(/##\s*Verdict:\s*(SHIP|NEEDS_WORK|MAJOR_RETHINK)/i);
  const verdictStr = verdictMatch?.[1];
  if (verdictStr) {
    result.verdict = verdictStr.toUpperCase() as ReviewVerdict;
  }

  const summaryMatch = output.match(/##\s*Verdict:.*?\n([\s\S]*?)(?=\n##|$)/i);
  const summaryStr = summaryMatch?.[1];
  if (summaryStr) {
    result.summary = summaryStr.trim();
  }

  const issuesMatch = output.match(/##\s*Issues?\s*\n([\s\S]*?)(?=\n##|$)/i);
  const issuesStr = issuesMatch?.[1];
  if (issuesStr) {
    result.issues = extractBulletItems(issuesStr);
  }

  const suggestionsMatch = output.match(/##\s*Suggestions?\s*\n([\s\S]*?)(?=\n##|$)/i);
  const suggestionsStr = suggestionsMatch?.[1];
  if (suggestionsStr) {
    result.suggestions = extractBulletItems(suggestionsStr);
  }

  return result;
}

function extractBulletItems(text: string) {
  return text
    .split("\n")
    .filter((line) => line.trim().startsWith("-") || line.trim().startsWith("*"))
    .map((line) => line.replace(/^[\s\-*]+/, "").trim())
    .filter(Boolean);
}
