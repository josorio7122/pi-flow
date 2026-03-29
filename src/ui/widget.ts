/**
 * widget.ts — Persistent widget showing running/completed agents above the editor.
 *
 * Displays a tree of agents with animated spinners, live stats, and activity descriptions.
 * Uses the callback form of setWidget for themed rendering.
 */

import type { ExtensionUIContext, Theme, ThemeColor } from "@mariozechner/pi-coding-agent";
import { type TUI, truncateToWidth } from "@mariozechner/pi-tui";
import type { AgentManager } from "../agents/manager.js";
import type { Registry } from "../agents/registry.js";
import type { SubagentType } from "../types.js";
import {
  type AgentActivity,
  type AgentDetails,
  describeActivity,
  ERROR_STATUSES,
  formatMs,
  formatTokens,
  formatTurns,
  getDisplayName,
  getPromptModeLabel,
  SPINNER,
} from "./formatters.js";



/** Maximum number of rendered lines before overflow collapse kicks in. */
const MAX_WIDGET_LINES = 12;

const STATUS_DISPLAY: Record<string, { color: ThemeColor; char: string; label: string }> = {
  completed: { color: "success", char: "✓", label: "" },
  steered:   { color: "warning", char: "✓", label: " (turn limit)" },
  stopped:   { color: "dim",     char: "■", label: " stopped" },
  error:     { color: "error",   char: "✗", label: " error" },
  aborted:   { color: "error",   char: "✗", label: " aborted" },
};

/** Pure — render a single finished agent line. */
export function renderFinishedLine(
  a: { id: string; type: SubagentType; status: string; description: string; toolUses: number; startedAt: number; completedAt?: number | undefined; error?: string | undefined },
  theme: Theme,
  activity?: AgentActivity,
  config?: { displayName: string; promptMode: "replace" | "append" },
) {
  const cfg = config ?? { displayName: a.type, promptMode: "replace" as const };
  const name = getDisplayName(a.type, cfg.displayName);
  const modeLabel = getPromptModeLabel(cfg.promptMode);
  const duration = formatMs((a.completedAt ?? Date.now()) - a.startedAt);

  const display = STATUS_DISPLAY[a.status] ?? STATUS_DISPLAY.aborted!;
  const icon = theme.fg(display.color, display.char);
  const statusSuffix = a.status === "error" && a.error
    ? theme.fg(display.color, `${display.label}: ${a.error.slice(0, 60)}`)
    : display.label ? theme.fg(display.color, display.label) : "";

  const parts = [
    ...(activity ? [formatTurns(activity.turnCount, activity.maxTurns)] : []),
    ...(a.toolUses > 0 ? [`${a.toolUses} tool use${a.toolUses === 1 ? "" : "s"}`] : []),
    duration,
  ];

  const modeTag = modeLabel ? ` ${theme.fg("dim", `(${modeLabel})`)}` : "";
  return `${icon} ${theme.fg("dim", name)}${modeTag}  ${theme.fg("dim", a.description)} ${theme.fg("dim", "·")} ${theme.fg("dim", parts.join(" · "))}${statusSuffix}`;
}

export class AgentWidget {
  private uiCtx: ExtensionUIContext | undefined;
  private widgetFrame = 0;
  private widgetInterval: ReturnType<typeof setInterval> | undefined;
  /** Tracks how many turns each finished agent has survived. Key: agent ID, Value: turns since finished. */
  private finishedTurnAge = new Map<string, number>();
  /** How many extra turns errors/aborted agents linger (completed agents clear after 1 turn). */
  private static readonly ERROR_LINGER_TURNS = 2;

  /** Whether the widget callback is currently registered with the TUI. */
  private widgetRegistered = false;
  /** Cached TUI reference from widget factory callback, used for requestRender(). */
  private tui: TUI | undefined;
  /** Last status bar text, used to avoid redundant setStatus calls. */
  private lastStatusText: string | undefined;

  constructor(
    private manager: AgentManager,
    private agentActivity: Map<string, AgentActivity>,
    private registry: Registry,
  ) {}

  /** Set the UI context (grabbed from first tool execution). */
  setUICtx(ctx: ExtensionUIContext) {
    if (ctx !== this.uiCtx) {
      // ExtensionUIContext changed — the widget registered on the old context is gone.
      // Force re-registration on next update().
      this.uiCtx = ctx;
      this.widgetRegistered = false;
      this.tui = undefined;
      this.lastStatusText = undefined;
    }
  }

  /**
   * Called on each new turn (tool_execution_start).
   * Ages finished agents and clears those that have lingered long enough.
   */
  onTurnStart() {
    // Age all finished agents
    for (const [id, age] of this.finishedTurnAge) {
      this.finishedTurnAge.set(id, age + 1);
    }
    // Trigger a widget refresh (will filter out expired agents)
    this.update();
  }

  /** Ensure the widget update timer is running. */
  ensureTimer() {
    if (!this.widgetInterval) {
      this.widgetInterval = setInterval(() => this.update(), 80);
    }
  }

  /** Check if a finished agent should still be shown in the widget. */
  private shouldShowFinished(agentId: string, status: string) {
    const age = this.finishedTurnAge.get(agentId) ?? 0;
    const maxAge = ERROR_STATUSES.has(status) ? AgentWidget.ERROR_LINGER_TURNS : 1;
    return age < maxAge;
  }

  /** Record an agent as finished (call when agent completes). */
  markFinished(agentId: string) {
    if (!this.finishedTurnAge.has(agentId)) {
      this.finishedTurnAge.set(agentId, 0);
    }
  }

  /** Render a finished agent line — delegates to pure function. */
  private renderFinishedLine(a: { id: string; type: SubagentType; status: string; description: string; toolUses: number; startedAt: number; completedAt?: number | undefined; error?: string | undefined }, theme: Theme) {
    return renderFinishedLine(a, theme, this.agentActivity.get(a.id), this.registry.getConfig(a.type));
  }

  /**
   * Render the widget content. Called from the registered widget's render() callback,
   * reading live state each time instead of capturing it in a closure.
   */
  private renderWidget(tui: TUI, theme: Theme) {
    const allAgents = this.manager.listAgents();
    const running = allAgents.filter(a => a.status === "running");
    const queued = allAgents.filter(a => a.status === "queued");
    const finished = allAgents.filter(a =>
      a.status !== "running" && a.status !== "queued" && a.completedAt
      && this.shouldShowFinished(a.id, a.status),
    );

    const hasActive = running.length > 0 || queued.length > 0;
    const hasFinished = finished.length > 0;

    // Nothing to show — return empty (widget will be unregistered by update())
    if (!hasActive && !hasFinished) return [];

    const w = tui.terminal.columns;
    const truncate = (line: string) => truncateToWidth(line, w);
    const headingColor = hasActive ? "accent" : "dim";
    const headingIcon = hasActive ? "●" : "○";
    const frame = SPINNER[this.widgetFrame % SPINNER.length] ?? "⠋";

    // Build sections separately for overflow-aware assembly.
    // Each running agent = 2 lines (header + activity), finished = 1 line, queued = 1 line.

    const finishedLines: string[] = [];
    for (const a of finished) {
      finishedLines.push(truncate(theme.fg("dim", "├─") + " " + this.renderFinishedLine(a, theme)));
    }

    const runningLines: string[][] = []; // each entry is [header, activity]
    for (const a of running) {
      const rcfg = this.registry.getConfig(a.type);
      const name = getDisplayName(a.type, rcfg.displayName);
      const modeLabel = getPromptModeLabel(rcfg.promptMode);
      const modeTag = modeLabel ? ` ${theme.fg("dim", `(${modeLabel})`)}` : "";
      const elapsed = formatMs(Date.now() - a.startedAt);

      const bg = this.agentActivity.get(a.id);
      const toolUses = bg?.toolUses ?? a.toolUses;
      let tokenText = "";
      if (bg?.session) {
        try { tokenText = formatTokens(bg.session.getSessionStats().tokens.total); } catch { /* */ }
      }

      const parts: string[] = [];
      if (bg) parts.push(formatTurns(bg.turnCount, bg.maxTurns));
      if (toolUses > 0) parts.push(`${toolUses} tool use${toolUses === 1 ? "" : "s"}`);
      if (tokenText) parts.push(tokenText);
      parts.push(elapsed);
      const statsText = parts.join(" · ");

      const activity = bg ? describeActivity(bg.activeTools, bg.responseText) : "thinking…";

      runningLines.push([
        truncate(theme.fg("dim", "├─") + ` ${theme.fg("accent", frame)} ${theme.bold(name)}${modeTag}  ${theme.fg("muted", a.description)} ${theme.fg("dim", "·")} ${theme.fg("dim", statsText)}`),
        truncate(theme.fg("dim", "│  ") + theme.fg("dim", `  ⎿  ${activity}`)),
      ]);
    }

    const queuedLine = queued.length > 0
      ? truncate(theme.fg("dim", "├─") + ` ${theme.fg("muted", "◦")} ${theme.fg("dim", `${queued.length} queued`)}`)
      : undefined;

    // Assemble with overflow cap (heading + overflow indicator = 2 reserved lines).
    const maxBody = MAX_WIDGET_LINES - 1; // heading takes 1 line
    const totalBody = finishedLines.length + runningLines.length * 2 + (queuedLine ? 1 : 0);

    const lines: string[] = [truncate(theme.fg(headingColor, headingIcon) + " " + theme.fg(headingColor, "Agents"))];

    if (totalBody <= maxBody) {
      // Everything fits — add all lines and fix up connectors for the last item.
      lines.push(...finishedLines);
      for (const pair of runningLines) lines.push(...pair);
      if (queuedLine) lines.push(queuedLine);

      // Fix last connector: swap ├─ → └─ and │ → space for activity lines.
      if (lines.length > 1) {
        const last = lines.length - 1;
        lines[last] = lines[last]!.replace("├─", "└─");
        // If last item is a running agent activity line, fix indent of that line
        // and fix the header line above it.
        if (runningLines.length > 0 && !queuedLine) {
          // The last two lines are the last running agent's header + activity.
          if (last >= 2) {
            lines[last - 1] = lines[last - 1]!.replace("├─", "└─");
            lines[last] = lines[last]!.replace("│  ", "   ");
          }
        }
      }
    } else {
      // Overflow — prioritize: running > queued > finished.
      // Reserve 1 line for overflow indicator.
      let budget = maxBody - 1;
      let hiddenRunning = 0;
      let hiddenFinished = 0;

      // 1. Running agents (2 lines each)
      for (const pair of runningLines) {
        if (budget >= 2) {
          lines.push(...pair);
          budget -= 2;
        } else {
          hiddenRunning++;
        }
      }

      // 2. Queued line
      if (queuedLine && budget >= 1) {
        lines.push(queuedLine);
        budget--;
      }

      // 3. Finished agents
      for (const fl of finishedLines) {
        if (budget >= 1) {
          lines.push(fl);
          budget--;
        } else {
          hiddenFinished++;
        }
      }

      // Overflow summary
      const overflowParts: string[] = [];
      if (hiddenRunning > 0) overflowParts.push(`${hiddenRunning} running`);
      if (hiddenFinished > 0) overflowParts.push(`${hiddenFinished} finished`);
      const overflowText = overflowParts.join(", ");
      lines.push(truncate(theme.fg("dim", "└─") + ` ${theme.fg("dim", `+${hiddenRunning + hiddenFinished} more (${overflowText})`)}`)
      );
    }

    return lines;
  }

  /** Force an immediate widget update. */
  update() {
    if (!this.uiCtx) return;
    const allAgents = this.manager.listAgents();

    // Lightweight existence checks — full categorization happens in renderWidget()
    let runningCount = 0;
    let queuedCount = 0;
    let hasFinished = false;
    for (const a of allAgents) {
      if (a.status === "running") { runningCount++; }
      else if (a.status === "queued") { queuedCount++; }
      else if (a.completedAt && this.shouldShowFinished(a.id, a.status)) { hasFinished = true; }
    }
    const hasActive = runningCount > 0 || queuedCount > 0;

    // Nothing to show — clear widget
    if (!hasActive && !hasFinished) {
      if (this.widgetRegistered) {
        this.uiCtx.setWidget("agents", undefined);
        this.widgetRegistered = false;
        this.tui = undefined;
      }
      if (this.lastStatusText !== undefined) {
        this.uiCtx.setStatus("subagents", undefined);
        this.lastStatusText = undefined;
      }
      if (this.widgetInterval) { clearInterval(this.widgetInterval); this.widgetInterval = undefined; }
      // Clean up stale entries
      for (const [id] of this.finishedTurnAge) {
        if (!allAgents.some(a => a.id === id)) this.finishedTurnAge.delete(id);
      }
      return;
    }

    // Status bar — only call setStatus when the text actually changes
    let newStatusText: string | undefined;
    if (hasActive) {
      const statusParts: string[] = [];
      if (runningCount > 0) statusParts.push(`${runningCount} running`);
      if (queuedCount > 0) statusParts.push(`${queuedCount} queued`);
      const total = runningCount + queuedCount;
      newStatusText = `${statusParts.join(", ")} agent${total === 1 ? "" : "s"}`;
    }
    if (newStatusText !== this.lastStatusText) {
      this.uiCtx.setStatus("subagents", newStatusText);
      this.lastStatusText = newStatusText;
    }

    this.widgetFrame++;

    // Register widget callback once; subsequent updates use requestRender()
    // which re-invokes render() without replacing the component (avoids layout thrashing).
    if (!this.widgetRegistered) {
      this.uiCtx.setWidget("agents", (tui, theme) => {
        this.tui = tui;
        return {
          render: () => this.renderWidget(tui, theme),
          invalidate: () => {
            // Theme changed — force re-registration so factory captures fresh theme.
            this.widgetRegistered = false;
            this.tui = undefined;
          },
        };
      }, { placement: "aboveEditor" });
      this.widgetRegistered = true;
    } else {
      // Widget already registered — just request a re-render of existing components.
      this.tui?.requestRender();
    }
  }

  dispose() {
    if (this.widgetInterval) {
      clearInterval(this.widgetInterval);
      this.widgetInterval = undefined;
    }
    if (this.uiCtx) {
      this.uiCtx.setWidget("agents", undefined);
      this.uiCtx.setStatus("subagents", undefined);
    }
    this.widgetRegistered = false;
    this.tui = undefined;
    this.lastStatusText = undefined;
  }
}
