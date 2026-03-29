/**
 * Read-only views: agent list, running agents, agent detail, conversation viewer.
 */

import { readFileSync, unlinkSync } from "node:fs";
import type { ExtensionCommandContext } from "@mariozechner/pi-coding-agent";
import type { AgentConfig, AgentRecord } from "../../types.js";
import { formatDuration, getDisplayName } from "../../ui/formatters.js";
import { disableAgent, ejectAgent, enableAgent } from "./mutations.js";
import { type CommandDeps, findAgentFile, getModelLabel } from "./types.js";

export async function showAllAgentsList(deps: CommandDeps, ctx: ExtensionCommandContext) {
  const { registry } = deps;
  const allNames = registry.getAllTypes();
  if (allNames.length === 0) {
    ctx.ui.notify("No agents.", "info");
    return;
  }

  const sourceIndicator = (cfg: AgentConfig | undefined) => {
    const disabled = cfg?.enabled === false;
    if (cfg?.source === "project") return disabled ? "✕• " : "•  ";
    if (cfg?.source === "global") return disabled ? "✕◦ " : "◦  ";
    return disabled ? "✕  " : "   ";
  };

  const entries = allNames.map((name) => {
    const cfg = registry.getAgentConfig(name);
    const disabled = cfg?.enabled === false;
    const model = getModelLabel({ type: name, deps, modelRegistry: ctx.modelRegistry });
    const indicator = sourceIndicator(cfg);
    const prefix = `${indicator}${name} · ${model}`;
    const desc = disabled ? "(disabled)" : (cfg?.description ?? name);
    return { name, prefix, desc };
  });
  const maxPrefix = Math.max(...entries.map((e) => e.prefix.length));

  const hasCustom = allNames.some((n) => {
    const c = registry.getAgentConfig(n);
    return c && !c.isDefault && c.enabled !== false;
  });
  const hasDisabled = allNames.some((n) => registry.getAgentConfig(n)?.enabled === false);
  const legendParts: string[] = [];
  if (hasCustom) legendParts.push("• = project  ◦ = global");
  if (hasDisabled) legendParts.push("✕ = disabled");
  const legend = legendParts.length ? "\n" + legendParts.join("  ") : "";

  const options = entries.map(({ prefix, desc }) => `${prefix.padEnd(maxPrefix)} — ${desc}`);
  if (legend) options.push(legend);

  const choice = await ctx.ui.select("Agent types", options);
  if (!choice) return;

  const agentName =
    choice
      .split(" · ")[0]
      ?.replace(/^[•◦✕\s]+/, "")
      .trim() ?? "";
  if (agentName && registry.getAgentConfig(agentName)) {
    await showAgentDetail({ deps, ctx, name: agentName });
    await showAllAgentsList(deps, ctx);
  }
}

export async function showRunningAgents(deps: CommandDeps, ctx: ExtensionCommandContext) {
  const { manager, registry } = deps;
  const agents = manager.listAgents();
  if (agents.length === 0) {
    ctx.ui.notify("No agents.", "info");
    return;
  }

  const options = agents.map((a) => {
    const acfg = registry.getAgentConfig(a.type);
    const dn = getDisplayName(a.type, acfg?.displayName);
    const dur = formatDuration(a.startedAt, a.completedAt);
    return `${dn} (${a.description}) · ${a.toolUses} tools · ${a.status} · ${dur}`;
  });

  const choice = await ctx.ui.select("Running agents", options);
  if (!choice) return;
  const idx = options.indexOf(choice);
  if (idx < 0) return;
  const record = agents[idx];
  if (!record) return;

  await viewAgentConversation({ deps, ctx, record });
  await showRunningAgents(deps, ctx);
}

async function viewAgentConversation({
  deps,
  ctx,
  record,
}: {
  deps: CommandDeps;
  ctx: ExtensionCommandContext;
  record: AgentRecord;
}) {
  if (!record.session) {
    ctx.ui.notify(`Agent is ${record.status === "queued" ? "queued" : "expired"} — no session available.`, "info");
    return;
  }
  const { ConversationViewer } = await import("../../ui/viewer.js");
  const activity = deps.agentActivity.get(record.id);
  await ctx.ui.custom<undefined>(
    (tui, theme, _, done) => new ConversationViewer(tui, record.session!, record, activity, theme, done, deps.registry),
    { overlay: true, overlayOptions: { anchor: "center", width: "90%" } },
  );
}

export async function showAgentDetail({
  deps,
  ctx,
  name,
}: {
  deps: CommandDeps;
  ctx: ExtensionCommandContext;
  name: string;
}) {
  const { registry, reloadCustomAgents } = deps;
  const cfg = registry.getAgentConfig(name);
  if (!cfg) {
    ctx.ui.notify(`Agent config not found for "${name}".`, "warning");
    return;
  }

  const file = findAgentFile(name);
  const isDefault = cfg.isDefault === true;
  const disabled = cfg.enabled === false;

  let menuOptions: string[];
  if (disabled && file) {
    menuOptions = isDefault
      ? ["Enable", "Edit", "Reset to default", "Delete", "Back"]
      : ["Enable", "Edit", "Delete", "Back"];
  } else if (isDefault && !file) {
    menuOptions = ["Eject (export as .md)", "Disable", "Back"];
  } else if (isDefault && file) {
    menuOptions = ["Edit", "Disable", "Reset to default", "Delete", "Back"];
  } else {
    menuOptions = ["Edit", "Disable", "Delete", "Back"];
  }

  const choice = await ctx.ui.select(name, menuOptions);
  if (!choice || choice === "Back") return;

  if (choice === "Edit" && file) {
    const content = readFileSync(file.path, "utf-8");
    const edited = await ctx.ui.editor(`Edit ${name}`, content);
    if (edited !== undefined && edited !== content) {
      const { writeFileSync } = await import("node:fs");
      writeFileSync(file.path, edited, "utf-8");
      reloadCustomAgents();
      ctx.ui.notify(`Updated ${file.path}`, "info");
    }
  } else if (choice === "Delete" && file) {
    const confirmed = await ctx.ui.confirm("Delete agent", `Delete ${name} from ${file.location} (${file.path})?`);
    if (confirmed) {
      unlinkSync(file.path);
      reloadCustomAgents();
      ctx.ui.notify(`Deleted ${file.path}`, "info");
    }
  } else if (choice === "Reset to default" && file) {
    const confirmed = await ctx.ui.confirm(
      "Reset to default",
      `Delete override ${file.path} and restore embedded default?`,
    );
    if (confirmed) {
      unlinkSync(file.path);
      reloadCustomAgents();
      ctx.ui.notify(`Restored default ${name}`, "info");
    }
  } else if (choice.startsWith("Eject")) {
    await ejectAgent({ deps, ctx, name, cfg });
  } else if (choice === "Disable") {
    await disableAgent({ deps, ctx, name });
  } else if (choice === "Enable") {
    await enableAgent({ deps, ctx, name });
  }
}
