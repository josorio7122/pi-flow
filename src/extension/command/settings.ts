/**
 * /agents settings submenu.
 */

import type { ExtensionCommandContext } from "@mariozechner/pi-coding-agent";
import { normalizeMaxTurns } from "../../agents/runner-types.js";
import type { JoinMode } from "../../types.js";
import type { CommandDeps } from "./types.js";

export async function showSettings(deps: CommandDeps, ctx: ExtensionCommandContext) {
  const { manager, runnerSettings, getDefaultJoinMode, setDefaultJoinMode } = deps;

  const choice = await ctx.ui.select("Settings", [
    `Max concurrency (current: ${manager.getMaxConcurrent()})`,
    `Default max turns (current: ${runnerSettings.defaultMaxTurns ?? "unlimited"})`,
    `Grace turns (current: ${runnerSettings.graceTurns})`,
    `Join mode (current: ${getDefaultJoinMode()})`,
  ]);
  if (!choice) return;

  if (choice.startsWith("Max concurrency")) {
    const val = await ctx.ui.input("Max concurrent background agents", String(manager.getMaxConcurrent()));
    if (val) {
      const n = parseInt(val, 10);
      if (n >= 1) {
        manager.setMaxConcurrent(n);
        ctx.ui.notify(`Max concurrency set to ${n}`, "info");
      } else ctx.ui.notify("Must be a positive integer.", "warning");
    }
  } else if (choice.startsWith("Default max turns")) {
    const val = await ctx.ui.input(
      "Default max turns before wrap-up (0 = unlimited)",
      String(runnerSettings.defaultMaxTurns ?? 0),
    );
    if (val) {
      const n = parseInt(val, 10);
      if (n === 0) {
        runnerSettings.defaultMaxTurns = undefined;
        ctx.ui.notify("Default max turns set to unlimited", "info");
      } else if (n >= 1) {
        runnerSettings.defaultMaxTurns = normalizeMaxTurns(n);
        ctx.ui.notify(`Default max turns set to ${n}`, "info");
      } else ctx.ui.notify("Must be 0 (unlimited) or a positive integer.", "warning");
    }
  } else if (choice.startsWith("Grace turns")) {
    const val = await ctx.ui.input("Grace turns after wrap-up steer", String(runnerSettings.graceTurns));
    if (val) {
      const n = parseInt(val, 10);
      if (n >= 1) {
        runnerSettings.graceTurns = Math.max(1, n);
        ctx.ui.notify(`Grace turns set to ${n}`, "info");
      } else ctx.ui.notify("Must be a positive integer.", "warning");
    }
  } else if (choice.startsWith("Join mode")) {
    const val = await ctx.ui.select("Default join mode for background agents", [
      "smart — auto-group 2+ agents in same turn (default)",
      "async — always notify individually",
      "group — always group background agents",
    ]);
    if (val) {
      setDefaultJoinMode(val.split(" ")[0] as JoinMode);
      ctx.ui.notify(`Default join mode set to ${val.split(" ")[0]}`, "info");
    }
  }
}
