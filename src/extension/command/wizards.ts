/**
 * Agent creation wizards: generate with Claude, manual configuration.
 */

import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionCommandContext } from "@mariozechner/pi-coding-agent";
import { BUILTIN_TOOL_NAMES } from "../../agents/registry.js";
import { type CommandDeps, personalAgentsDir, projectAgentsDir } from "./types.js";

export async function showCreateWizard(deps: CommandDeps, ctx: ExtensionCommandContext) {
  const location = await ctx.ui.select("Choose location", ["Project (.pi/agents/)", "Personal (~/.pi/agent/agents/)"]);
  if (!location) return;
  const targetDir = location.startsWith("Project") ? projectAgentsDir() : personalAgentsDir();
  const method = await ctx.ui.select("Creation method", ["Generate with Claude (recommended)", "Manual configuration"]);
  if (!method) return;
  if (method.startsWith("Generate")) await showGenerateWizard(deps, ctx, targetDir);
  else await showManualWizard(deps, ctx, targetDir);
}

async function showGenerateWizard(deps: CommandDeps, ctx: ExtensionCommandContext, targetDir: string) {
  const description = await ctx.ui.input("Describe what this agent should do");
  if (!description) return;
  const name = await ctx.ui.input("Agent name (filename, no spaces)");
  if (!name) return;

  mkdirSync(targetDir, { recursive: true });
  const targetPath = join(targetDir, `${name}.md`);
  if (existsSync(targetPath)) {
    const overwrite = await ctx.ui.confirm("Overwrite", `${targetPath} already exists. Overwrite?`);
    if (!overwrite) return;
  }

  ctx.ui.notify("Generating agent definition...", "info");

  const generatePrompt = `Create a custom pi sub-agent definition file based on this description: "${description}"

Write a markdown file to: ${targetPath}

The file format is a markdown file with YAML frontmatter and a system prompt body:

\`\`\`markdown
---
description: <one-line description shown in UI>
tools: <comma-separated built-in tools: read, bash, edit, write, grep, find, ls. Use "none" for no tools. Omit for all tools>
model: <optional model as "provider/modelId". Omit to inherit parent model>
thinking: <optional thinking level: off, minimal, low, medium, high, xhigh. Omit to inherit>
max_turns: <optional max agentic turns. 0 or omit for unlimited>
prompt_mode: <"replace" or "append". Default: replace>
extensions: <true, false, or comma-separated names. Default: true>
skills: <true, false, or comma-separated skill names. Default: true>
disallowed_tools: <comma-separated tool names to block. Omit for none>
inherit_context: <true to fork parent conversation. Default: false>
run_in_background: <true for background by default. Default: false>
isolated: <true for no extension/MCP tools. Default: false>
memory: <"user", "project", or "local" for persistent memory. Omit for none>
isolation: <"worktree" for isolated git worktree. Omit for normal>
---

<system prompt body>
\`\`\`

Write the file using the write tool. Only write the file, nothing else.`;

  const record = await deps.manager.spawnAndWait({
    pi: deps.pi,
    ctx,
    type: "general-purpose",
    prompt: generatePrompt,
    options: { description: `Generate ${name} agent`, maxTurns: 5 },
  });

  if (record.status === "error") {
    ctx.ui.notify(`Generation failed: ${record.error}`, "warning");
    return;
  }
  deps.reloadCustomAgents();
  ctx.ui.notify(
    existsSync(targetPath) ? `Created ${targetPath}` : "Agent generation completed but file was not created.",
    existsSync(targetPath) ? "info" : "warning",
  );
}

async function showManualWizard(deps: CommandDeps, ctx: ExtensionCommandContext, targetDir: string) {
  const name = await ctx.ui.input("Agent name (filename, no spaces)");
  if (!name) return;
  const description = await ctx.ui.input("Description (one line)");
  if (!description) return;

  const toolChoice = await ctx.ui.select("Tools", [
    "all",
    "none",
    "read-only (read, bash, grep, find, ls)",
    "custom...",
  ]);
  if (!toolChoice) return;

  let tools: string;
  if (toolChoice === "all") tools = BUILTIN_TOOL_NAMES.join(", ");
  else if (toolChoice === "none") tools = "none";
  else if (toolChoice.startsWith("read-only")) tools = "read, bash, grep, find, ls";
  else {
    const customTools = await ctx.ui.input("Tools (comma-separated)", BUILTIN_TOOL_NAMES.join(", "));
    if (!customTools) return;
    tools = customTools;
  }

  const modelChoice = await ctx.ui.select("Model", ["inherit (parent model)", "haiku", "sonnet", "opus", "custom..."]);
  if (!modelChoice) return;

  let modelLine = "";
  if (modelChoice === "haiku") modelLine = "\nmodel: anthropic/claude-haiku-4-5-20251001";
  else if (modelChoice === "sonnet") modelLine = "\nmodel: anthropic/claude-sonnet-4-6";
  else if (modelChoice === "opus") modelLine = "\nmodel: anthropic/claude-opus-4-6";
  else if (modelChoice === "custom...") {
    const customModel = await ctx.ui.input("Model (provider/modelId)");
    if (customModel) modelLine = `\nmodel: ${customModel}`;
  }

  const thinkingChoice = await ctx.ui.select("Thinking level", [
    "inherit",
    "off",
    "minimal",
    "low",
    "medium",
    "high",
    "xhigh",
  ]);
  if (!thinkingChoice) return;
  const thinkingLine = thinkingChoice !== "inherit" ? `\nthinking: ${thinkingChoice}` : "";

  const systemPrompt = await ctx.ui.editor("System prompt", "");
  if (systemPrompt === undefined) return;

  const content = `---\ndescription: ${description}\ntools: ${tools}${modelLine}${thinkingLine}\nprompt_mode: replace\n---\n\n${systemPrompt}\n`;

  mkdirSync(targetDir, { recursive: true });
  const targetPath = join(targetDir, `${name}.md`);
  if (existsSync(targetPath)) {
    const overwrite = await ctx.ui.confirm("Overwrite", `${targetPath} already exists. Overwrite?`);
    if (!overwrite) return;
  }

  const { writeFileSync } = await import("node:fs");
  writeFileSync(targetPath, content, "utf-8");
  deps.reloadCustomAgents();
  ctx.ui.notify(`Created ${targetPath}`, "info");
}
