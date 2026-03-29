/**
 * /flow command — view workflow progress and manage active workflows.
 */

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { formatDuration } from "./progress.js";
import { listHandoffs, readEvents, readState, writeState } from "./store.js";
import type { WorkflowDefinition, WorkflowEvent } from "./types.js";

export function registerFlowCommand({
  pi,
  getActiveWorkflowId,
  setActiveWorkflow,
  emitEvent,
  doRefreshWidget,
}: {
  pi: ExtensionAPI;
  getActiveWorkflowId: () => string | undefined;
  setActiveWorkflow: (id: string | undefined, def: WorkflowDefinition | undefined) => void;
  emitEvent: (cwd: string, event: WorkflowEvent) => void;
  doRefreshWidget: (ctx: ExtensionContext) => void;
}) {
  pi.registerCommand("flow", {
    description: "View workflow progress and manage active workflows",
    handler: async (_args, ctx) => {
      const activeWorkflowId = getActiveWorkflowId();
      if (!activeWorkflowId) {
        ctx.ui.notify("No active workflow.", "info");
        return;
      }
      const state = readState(ctx.cwd, activeWorkflowId);
      if (!state) {
        ctx.ui.notify("Workflow state not found.", "error");
        return;
      }
      const events = readEvents(ctx.cwd, activeWorkflowId);
      const handoffs = listHandoffs(ctx.cwd, activeWorkflowId);
      const elapsed = formatDuration(Date.now() - state.startedAt);
      const lines = [
        `Workflow: ${state.type} — ${state.description}`,
        `ID: ${state.id} | Phase: ${state.currentPhase} | Elapsed: ${elapsed}`,
        `Tokens: ${state.tokens.total} | Review cycles: ${state.reviewCycle}`,
        "",
        "Phases:",
        ...Object.values(state.phases).map(
          (p) =>
            `  ${p.status === "complete" ? "\u2713" : p.status === "running" ? "\u25CF" : "\u25CB"} ${p.phase} (${p.status})`,
        ),
        "",
        `Handoffs: ${handoffs.length} | Events: ${events.length}`,
      ];
      const choice = await ctx.ui.select(lines.join("\n"), ["Close", "Abort workflow"]);
      if (choice === "Abort workflow") {
        const confirmed = await ctx.ui.confirm("Abort workflow?", `This will stop ${state.id}`);
        if (confirmed) {
          state.exitReason = "user_abort";
          state.completedAt = Date.now();
          writeState(ctx.cwd, activeWorkflowId, state);
          emitEvent(ctx.cwd, {
            type: "workflow_complete",
            exitReason: "user_abort",
            totalDuration: Date.now() - state.startedAt,
            totalTokens: state.tokens.total,
            ts: Date.now(),
          });
          setActiveWorkflow(undefined, undefined);
          doRefreshWidget(ctx);
          ctx.ui.notify("Workflow aborted.", "info");
        }
      }
    },
  });
}
