/**
 * /agents command — entry point and top-level menu.
 */

import type { ExtensionCommandContext } from "@mariozechner/pi-coding-agent";
import { showSettings } from "./settings.js";
import type { CommandDeps } from "./types.js";
import { showAllAgentsList, showRunningAgents } from "./views.js";
import { showCreateWizard } from "./wizards.js";

export type { CommandDeps } from "./types.js";

async function showAgentsMenu(deps: CommandDeps, ctx: ExtensionCommandContext) {
  const { manager } = deps;
  const running = manager.listAgents().filter((a) => a.status === "running" || a.status === "queued");

  const options = [
    "All agents",
    ...(running.length > 0 ? [`Running agents (${running.length})`] : []),
    "Create new agent",
    "Settings",
  ];

  const choice = await ctx.ui.select("/agents", options);
  if (!choice) return;

  if (choice === "All agents") {
    await showAllAgentsList(deps, ctx);
  } else if (choice.startsWith("Running")) {
    await showRunningAgents(deps, ctx);
  } else if (choice === "Create new agent") {
    await showCreateWizard(deps, ctx);
  } else if (choice === "Settings") {
    await showSettings(deps, ctx);
  }
}

export function registerAgentsCommand(deps: CommandDeps) {
  deps.pi.registerCommand("agents", {
    description: "Manage agents",
    handler: async (_args, ctx) => {
      await showAgentsMenu(deps, ctx);
    },
  });
}
