/**
 * widget.ts — Persistent widget showing running/queued agents above the editor.
 * Only active agents are shown. Completed agents are reported via a summary
 * message in the conversation, then removed from the widget.
 */

import type { ExtensionUIContext, Theme } from "@mariozechner/pi-coding-agent";
import type { TUI } from "@mariozechner/pi-tui";
import type { AgentManager } from "../agents/manager.js";
import type { Registry } from "../agents/registry.js";
import { type AgentActivity, SPINNER } from "./formatters.js";
import { assembleWidgetLines, renderRunningLine } from "./widget-render.js";

export class AgentWidget {
  private uiCtx: ExtensionUIContext | undefined;
  private widgetFrame = 0;
  private widgetInterval: ReturnType<typeof setInterval> | undefined;
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

  ensureTimer() {
    if (!this.widgetInterval) {
      this.widgetInterval = setInterval(() => this.update(), 80);
    }
  }

  private renderWidget(tui: TUI, theme: Theme) {
    const allAgents = this.manager.listAgents();
    const running = allAgents.filter((a) => a.status === "running");
    const queued = allAgents.filter((a) => a.status === "queued");

    if (running.length === 0 && queued.length === 0) return [];

    // Single foreground agent — tool block already shows everything
    if (running.length === 1 && queued.length === 0) return [];

    const frame = SPINNER[this.widgetFrame % SPINNER.length] ?? "⠋";

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
      heading: `${theme.fg("accent", "●")} ${theme.fg("accent", "Agents")}`,
      runningPairs,
      queuedLine,
      width: tui.terminal.columns,
      theme,
    });
  }

  update() {
    if (!this.uiCtx) return;
    const allAgents = this.manager.listAgents();

    let runningCount = 0;
    let queuedCount = 0;
    for (const a of allAgents) {
      if (a.status === "running") runningCount++;
      else if (a.status === "queued") queuedCount++;
    }
    const hasActive = runningCount > 0 || queuedCount > 0;

    if (!hasActive) {
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
      return;
    }

    const statusParts: string[] = [];
    if (runningCount > 0) statusParts.push(`${runningCount} running`);
    if (queuedCount > 0) statusParts.push(`${queuedCount} queued`);
    const total = runningCount + queuedCount;
    const newStatusText = `${statusParts.join(", ")} agent${total === 1 ? "" : "s"}`;
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
