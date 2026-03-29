/**
 * Agent tool render callbacks — Claude Code style TUI rendering.
 * Pure functions: take theme + details, return Text nodes.
 */

import type { Theme } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import type { AgentDetails } from "../../ui/formatters.js";
import { formatMs, formatTurns, getDisplayName, SPINNER } from "../../ui/formatters.js";
import type { Registry } from "../registry.js";

function buildStats(d: AgentDetails, theme: Theme) {
  const parts: string[] = [];
  if (d.modelName) parts.push(d.modelName);
  if (d.tags) parts.push(...d.tags);
  if (d.turnCount != null && d.turnCount > 0) parts.push(formatTurns(d.turnCount, d.maxTurns));
  if (d.toolUses > 0) parts.push(`${d.toolUses} tool use${d.toolUses === 1 ? "" : "s"}`);
  if (d.tokens) parts.push(d.tokens);
  return parts.map((p) => theme.fg("dim", p)).join(" " + theme.fg("dim", "·") + " ");
}

export function renderAgentCall(args: Record<string, unknown>, theme: Theme, registry: Registry) {
  const argConfig = args.subagent_type ? registry.getAgentConfig(args.subagent_type as string) : undefined;
  const displayName = args.subagent_type
    ? getDisplayName(args.subagent_type as string, argConfig?.displayName)
    : "Agent";
  const desc = (args.description as string) ?? "";
  return new Text(
    "▸ " + theme.fg("toolTitle", theme.bold(displayName)) + (desc ? "  " + theme.fg("muted", desc) : ""),
    0,
    0,
  );
}

export function renderAgentResult(
  result: { content: { type: string; text?: string }[]; details?: unknown },
  { expanded, isPartial }: { expanded: boolean; isPartial: boolean },
  theme: Theme,
) {
  const details = result.details as AgentDetails | undefined;
  if (!details) {
    const text = result.content[0]?.type === "text" ? result.content[0].text : "";
    return new Text(text ?? "", 0, 0);
  }

  if (isPartial || details.status === "running") {
    const frame = SPINNER[details.spinnerFrame ?? 0] ?? "⠋";
    const s = buildStats(details, theme);
    let line = theme.fg("accent", frame) + (s ? " " + s : "");
    line += "\n" + theme.fg("dim", `  ⎿  ${details.activity ?? "thinking…"}`);
    return new Text(line, 0, 0);
  }

  if (details.status === "background") {
    return new Text(theme.fg("dim", `  ⎿  Running in background (ID: ${details.agentId})`), 0, 0);
  }

  if (details.status === "completed" || details.status === "steered") {
    const duration = formatMs(details.durationMs);
    const isSteered = details.status === "steered";
    const icon = isSteered ? theme.fg("warning", "✓") : theme.fg("success", "✓");
    const s = buildStats(details, theme);
    let line = icon + (s ? " " + s : "");
    line += " " + theme.fg("dim", "·") + " " + theme.fg("dim", duration);

    if (expanded) {
      const resultText = result.content[0]?.type === "text" ? result.content[0].text : "";
      if (resultText) {
        const lines = resultText.split("\n").slice(0, 50);
        for (const l of lines) line += "\n" + theme.fg("dim", `  ${l}`);
        if (resultText.split("\n").length > 50) {
          line += "\n" + theme.fg("muted", "  ... (use get_subagent_result with verbose for full output)");
        }
      }
    } else {
      const doneText = isSteered ? "Wrapped up (turn limit)" : "Done";
      line += "\n" + theme.fg("dim", `  ⎿  ${doneText}`);
    }
    return new Text(line, 0, 0);
  }

  if (details.status === "stopped") {
    const s = buildStats(details, theme);
    let line = theme.fg("dim", "■") + (s ? " " + s : "");
    line += "\n" + theme.fg("dim", "  ⎿  Stopped");
    return new Text(line, 0, 0);
  }

  const s = buildStats(details, theme);
  let line = theme.fg("error", "✗") + (s ? " " + s : "");
  if (details.status === "error") {
    line += "\n" + theme.fg("error", `  ⎿  Error: ${details.error ?? "unknown"}`);
  } else {
    line += "\n" + theme.fg("warning", "  ⎿  Aborted (max turns exceeded)");
  }
  return new Text(line, 0, 0);
}
