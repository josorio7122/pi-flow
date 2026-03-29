/**
 * Mutating agent operations: eject, disable, enable.
 */

import { existsSync, mkdirSync, readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionCommandContext } from "@mariozechner/pi-coding-agent";
import type { AgentConfig } from "../../types.js";
import { type CommandDeps, findAgentFile, personalAgentsDir, projectAgentsDir } from "./types.js";

export async function ejectAgent(deps: CommandDeps, ctx: ExtensionCommandContext, name: string, cfg: AgentConfig) {
  const location = await ctx.ui.select("Choose location", ["Project (.pi/agents/)", "Personal (~/.pi/agent/agents/)"]);
  if (!location) return;

  const targetDir = location.startsWith("Project") ? projectAgentsDir() : personalAgentsDir();
  mkdirSync(targetDir, { recursive: true });

  const targetPath = join(targetDir, `${name}.md`);
  if (existsSync(targetPath)) {
    const overwrite = await ctx.ui.confirm("Overwrite", `${targetPath} already exists. Overwrite?`);
    if (!overwrite) return;
  }

  const fmFields: string[] = [];
  fmFields.push(`description: ${cfg.description}`);
  if (cfg.displayName) fmFields.push(`display_name: ${cfg.displayName}`);
  fmFields.push(`tools: ${cfg.builtinToolNames?.join(", ") || "all"}`);
  if (cfg.model) fmFields.push(`model: ${cfg.model}`);
  if (cfg.thinking) fmFields.push(`thinking: ${cfg.thinking}`);
  if (cfg.maxTurns) fmFields.push(`max_turns: ${cfg.maxTurns}`);
  fmFields.push(`prompt_mode: ${cfg.promptMode}`);
  if (cfg.extensions === false) fmFields.push("extensions: false");
  else if (Array.isArray(cfg.extensions)) fmFields.push(`extensions: ${cfg.extensions.join(", ")}`);
  if (cfg.skills === false) fmFields.push("skills: false");
  else if (Array.isArray(cfg.skills)) fmFields.push(`skills: ${cfg.skills.join(", ")}`);
  if (cfg.disallowedTools?.length) fmFields.push(`disallowed_tools: ${cfg.disallowedTools.join(", ")}`);
  if (cfg.inheritContext) fmFields.push("inherit_context: true");
  if (cfg.runInBackground) fmFields.push("run_in_background: true");
  if (cfg.isolated) fmFields.push("isolated: true");
  if (cfg.memory) fmFields.push(`memory: ${cfg.memory}`);
  if (cfg.isolation) fmFields.push(`isolation: ${cfg.isolation}`);

  const content = `---\n${fmFields.join("\n")}\n---\n\n${cfg.systemPrompt}\n`;
  const { writeFileSync } = await import("node:fs");
  writeFileSync(targetPath, content, "utf-8");
  deps.reloadCustomAgents();
  ctx.ui.notify(`Ejected ${name} to ${targetPath}`, "info");
}

export async function disableAgent(deps: CommandDeps, ctx: ExtensionCommandContext, name: string) {
  const file = findAgentFile(name);
  if (file) {
    const content = readFileSync(file.path, "utf-8");
    if (content.includes("\nenabled: false\n")) {
      ctx.ui.notify(`${name} is already disabled.`, "info");
      return;
    }
    const updated = content.replace(/^---\n/, "---\nenabled: false\n");
    const { writeFileSync } = await import("node:fs");
    writeFileSync(file.path, updated, "utf-8");
    deps.reloadCustomAgents();
    ctx.ui.notify(`Disabled ${name} (${file.path})`, "info");
    return;
  }

  const location = await ctx.ui.select("Choose location", ["Project (.pi/agents/)", "Personal (~/.pi/agent/agents/)"]);
  if (!location) return;
  const targetDir = location.startsWith("Project") ? projectAgentsDir() : personalAgentsDir();
  mkdirSync(targetDir, { recursive: true });
  const targetPath = join(targetDir, `${name}.md`);
  const { writeFileSync } = await import("node:fs");
  writeFileSync(targetPath, "---\nenabled: false\n---\n", "utf-8");
  deps.reloadCustomAgents();
  ctx.ui.notify(`Disabled ${name} (${targetPath})`, "info");
}

export async function enableAgent(deps: CommandDeps, ctx: ExtensionCommandContext, name: string) {
  const file = findAgentFile(name);
  if (!file) return;
  const content = readFileSync(file.path, "utf-8");
  const updated = content.replace(/^(---\n)enabled: false\n/, "$1");
  const { writeFileSync } = await import("node:fs");
  if (updated.trim() === "---\n---" || updated.trim() === "---\n---\n") {
    unlinkSync(file.path);
    deps.reloadCustomAgents();
    ctx.ui.notify(`Enabled ${name} (removed ${file.path})`, "info");
  } else {
    writeFileSync(file.path, updated, "utf-8");
    deps.reloadCustomAgents();
    ctx.ui.notify(`Enabled ${name} (${file.path})`, "info");
  }
}
