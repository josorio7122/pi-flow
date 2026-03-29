/**
 * widget.ts — Persistent widget showing running/completed agents above the editor.
 * State management, timers, registration. Rendering delegated to widget-render.ts.
 */

import type { ExtensionUIContext, Theme } from "@mariozechner/pi-coding-agent";
import type { TUI } from "@mariozechner/pi-tui";
import type { AgentManager } from "../agents/manager.js";
import type { Registry } from "../agents/registry.js";
import { type AgentActivity, ERROR_STATUSES, SPINNER } from "./formatters.js";
import { assembleWidgetLines, renderFinishedLine, renderRunningLine } from "./widget-render.js";

export class AgentWidget {
  private uiCtx: ExtensionUIContext | undefined;
  private widgetFrame = 0;
  private widgetInterval: ReturnType<typeof setInterval> | undefined;
  private finishedTurnAge = new Map<string, number>();
  private static readonly NORMAL_LINGER_TURNS = 3;
  private static readonly ERROR_LINGER_TURNS = 5;
  private widgetRegistered = false;
  private tui: TUI | undefined;
  private lastStatusText: string | undefined;

  private manager: AgentManager;
  private agentActivity: Map<string, AgentActivity>;
  private registry: Registry;

  constructor({
    manager,
    agentActivity,
    registry,
  }: { manager: AgentManager; agentActivity: Map<string, AgentActivity>; registry: Registry }) {
    this.manager = manager;
    this.agentActivity = agentActivity;
    this.registry = registry;
  }

  setUICtx(ctx: ExtensionUIContext) {
    if (ctx !== this.uiCtx) {
      this.uiCtx = ctx;
      this.widgetRegistered = false;
      this.tui = undefined;
      this.lastStatusText = undefined;
    }
  }

  onTurnStart() {
    for (const [id, age] of this.finishedTurnAge) {
      this.finishedTurnAge.set(id, age + 1);
    }
    this.update();
  }

  ensureTimer() {
    if (!this.widgetInterval) {
      this.widgetInterval = setInterval(() => this.update(), 80);
    }
  }

  private shouldShowFinished(agentId: string, status: string) {
    const age = this.finishedTurnAge.get(agentId) ?? 0;
    const maxAge = ERROR_STATUSES.has(status) ? AgentWidget.ERROR_LINGER_TURNS : AgentWidget.NORMAL_LINGER_TURNS;
    return age < maxAge;
  }

  markFinished(agentId: string) {
    if (!this.finishedTurnAge.has(agentId)) this.finishedTurnAge.set(agentId, 0);
  }

  private renderWidget(tui: TUI, theme: Theme) {
    const allAgents = this.manager.listAgents();
    const running = allAgents.filter((a) => a.status === "running");
    const queued = allAgents.filter((a) => a.status === "queued");
    const finished = allAgents.filter(
      (a) =>
        a.status !== "running" && a.status !== "queued" && a.completedAt && this.shouldShowFinished(a.id, a.status),
    );

    const hasActive = running.length > 0 || queued.length > 0;
    if (!hasActive && finished.length === 0) return [];

    // Single foreground agent with nothing else — tool block already shows everything
    if (running.length === 1 && queued.length === 0 && finished.length === 0) return [];

    const frame = SPINNER[this.widgetFrame % SPINNER.length] ?? "⠋";
    const headingColor = hasActive ? "accent" : "dim";
    const headingIcon = hasActive ? "●" : "○";

    const finishedLines = finished.map(
      (a) =>
        `${theme.fg("dim", "├─")} ${renderFinishedLine({ agent: a, theme, activity: this.agentActivity.get(a.id), config: this.registry.getConfig(a.type) })}`,
    );

    const runningPairs = running.map((a) =>
      renderRunningLine({
        agent: a,
        theme,
        activity: this.agentActivity.get(a.id),
        config: this.registry.getConfig(a.type),
        frame,
      }),
    );

    const queuedLine =
      queued.length > 0
        ? `${theme.fg("dim", "├─")} ${theme.fg("muted", "◦")} ${theme.fg("dim", `${queued.length} queued`)}`
        : undefined;

    return assembleWidgetLines({
      heading: `${theme.fg(headingColor, headingIcon)} ${theme.fg(headingColor, "Agents")}`,
      finishedLines,
      runningPairs,
      queuedLine,
      width: tui.terminal.columns,
      theme,
    });
  }

  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: tracks widget lifecycle across running/queued/finished states
  update() {
    if (!this.uiCtx) return;
    const allAgents = this.manager.listAgents();

    let runningCount = 0;
    let queuedCount = 0;
    let hasFinished = false;
    for (const a of allAgents) {
      if (a.status === "running") runningCount++;
      else if (a.status === "queued") queuedCount++;
      else if (a.completedAt && this.shouldShowFinished(a.id, a.status)) hasFinished = true;
    }
    const hasActive = runningCount > 0 || queuedCount > 0;

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
      if (this.widgetInterval) {
        clearInterval(this.widgetInterval);
        this.widgetInterval = undefined;
      }
      for (const [id] of this.finishedTurnAge) {
        if (!allAgents.some((a) => a.id === id)) this.finishedTurnAge.delete(id);
      }
      return;
    }

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

    if (!this.widgetRegistered) {
      this.uiCtx.setWidget(
        "agents",
        (tui, theme) => {
          this.tui = tui;
          return {
            render: () => this.renderWidget(tui, theme),
            invalidate: () => {
              this.widgetRegistered = false;
              this.tui = undefined;
            },
          };
        },
        { placement: "aboveEditor" },
      );
      this.widgetRegistered = true;
    } else {
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
