/**
 * Agent tool — spawn a sub-agent (foreground or background).
 * Extracted from index.ts. Renders delegated to agent-render.ts.
 */

import type { AgentSession, ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { resolveAgentInvocationConfig, resolveJoinMode } from "../../config/invocation.js";
import { resolveModel } from "../../config/model-resolver.js";
import { createActivityTracker } from "../../extension/activity-tracker.js";
import { buildDetails, getStatusNote, safeFormatTokens, textResult } from "../../extension/helpers.js";
import { createOutputFilePath, streamToOutputFile, writeInitialEntry } from "../../infra/output-file.js";
import {
  type AgentActivity,
  type AgentDetails,
  describeActivity,
  formatMs,
  getDisplayName,
  SPINNER,
} from "../../ui/formatters.js";
import type { AgentWidget } from "../../ui/widget.js";
import type { BatchSystem } from "../batch.js";
import type { AgentManager } from "../manager.js";
import type { Registry } from "../registry.js";
import { normalizeMaxTurns, type RunnerSettings } from "../runner-types.js";
import { renderAgentCall, renderAgentResult } from "./agent-render.js";

interface AgentToolDeps {
  pi: ExtensionAPI;
  manager: AgentManager;
  registry: Registry;
  widget: AgentWidget;
  agentActivity: Map<string, AgentActivity>;
  runnerSettings: RunnerSettings;
  batch: BatchSystem;
  reloadCustomAgents: () => void;
}

function getModelLabelFromConfig(model: string) {
  const name = model.includes("/") ? model.split("/").pop()! : model;
  return name.replace(/-\d{8}$/, "");
}

function buildTypeListText(registry: Registry) {
  const defaultDescs = registry.getDefaultAgentNames().map((name) => {
    const cfg = registry.getAgentConfig(name);
    const modelSuffix = cfg?.model ? ` (${getModelLabelFromConfig(cfg.model)})` : "";
    return `- ${name}: ${cfg?.description ?? name}${modelSuffix}`;
  });
  const customDescs = registry.getUserAgentNames().map((name) => {
    const cfg = registry.getAgentConfig(name);
    return `- ${name}: ${cfg?.description ?? name}`;
  });
  return [
    "Default agents:",
    ...defaultDescs,
    ...(customDescs.length > 0 ? ["", "Custom agents:", ...customDescs] : []),
    "",
    "Custom agents can be defined in .pi/agents/<name>.md (project) or ~/.pi/agent/agents/<name>.md (global).",
  ].join("\n");
}

export function registerAgentTool(deps: AgentToolDeps) {
  const { pi, manager, registry, widget, agentActivity, runnerSettings, batch } = deps;
  const typeListText = buildTypeListText(registry);

  pi.registerTool({
    name: "Agent",
    label: "Agent",
    promptSnippet:
      "Agent — Spawn a specialized agent (scout, builder, reviewer, planner, test-writer) for a single focused task",
    promptGuidelines: [
      "Agent is for single-phase tasks only: just a scout, just a review, just a build. If the task involves exploration followed by changes (scout then fix/clean/build), use the Workflow tool instead — never spawn a scout via Agent and then do the changes yourself.",
      "Use run_in_background: true to run multiple agents in parallel for independent subtasks. Foreground calls block until the agent completes.",
    ],
    description: `Launch a specialized agent to handle a focused task autonomously.

Available agent types:
${typeListText}

Usage:
- Provide clear, detailed prompts so the agent can work autonomously.
- Use steer_subagent to send mid-run messages to a running background agent.
- Use model for a different model, thinking for extended thinking, inherit_context for parent history.
- Use isolation: "worktree" for safe parallel file modifications.`,
    parameters: Type.Object({
      prompt: Type.String({ description: "The task for the agent to perform." }),
      description: Type.String({ description: "A short (3-5 word) description of the task (shown in UI)." }),
      subagent_type: Type.String({ description: `Agent type. Available: ${registry.getAvailableTypes().join(", ")}.` }),
      model: Type.Optional(Type.String({ description: 'Model override. "provider/modelId" or fuzzy name.' })),
      thinking: Type.Optional(Type.String({ description: "Thinking level: off, minimal, low, medium, high, xhigh." })),
      max_turns: Type.Optional(Type.Number({ description: "Max agentic turns.", minimum: 1 })),
      run_in_background: Type.Optional(Type.Boolean({ description: "Run in background." })),
      resume: Type.Optional(Type.String({ description: "Agent ID to resume from." })),
      isolated: Type.Optional(Type.Boolean({ description: "No extension/MCP tools." })),
      inherit_context: Type.Optional(Type.Boolean({ description: "Fork parent conversation." })),
      isolation: Type.Optional(Type.Literal("worktree", { description: "Git worktree isolation." })),
    }),
    renderCall: (args, theme) => renderAgentCall({ args, theme, registry }),
    // biome-ignore lint/complexity/useMaxParams: pi renderResult callback signature is fixed
    renderResult: (result, opts, theme) => renderAgentResult(result, { ...opts, theme }),

    // biome-ignore lint/complexity/useMaxParams: pi tool execute callback signature is fixed
    // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: orchestrates model resolution, background/foreground/resume paths
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      widget.setUICtx(ctx.ui);
      deps.reloadCustomAgents();

      const rawType = params.subagent_type;
      const resolved = registry.resolveType(rawType);
      const subagentType = resolved ?? "general-purpose";
      const fellBack = resolved === undefined;
      const customConfig = registry.getAgentConfig(subagentType);
      const displayName = getDisplayName(subagentType, customConfig?.displayName);
      const resolvedConfig = resolveAgentInvocationConfig(customConfig, params);

      let model = ctx.model;
      if (resolvedConfig.modelInput) {
        const r = resolveModel(resolvedConfig.modelInput, ctx.modelRegistry);
        if (typeof r === "string") {
          if (resolvedConfig.modelFromParams) return textResult(r);
        } else {
          model = r;
        }
      }

      const { thinking, inheritContext, runInBackground, isolated, isolation } = resolvedConfig;
      const effectiveMaxTurns = normalizeMaxTurns(resolvedConfig.maxTurns ?? runnerSettings.defaultMaxTurns);

      // Build display tags
      const parentModelId = ctx.model?.id;
      const effectiveModelId = model?.id;
      const agentModelName =
        effectiveModelId && effectiveModelId !== parentModelId
          ? (model?.name ?? effectiveModelId).replace(/^Claude\s+/i, "").toLowerCase()
          : undefined;
      const agentTags: string[] = [];
      if (thinking) agentTags.push(`thinking: ${thinking}`);
      if (isolated) agentTags.push("isolated");
      if (isolation === "worktree") agentTags.push("worktree");
      const detailBase = {
        displayName,
        description: params.description,
        subagentType,
        modelName: agentModelName,
        tags: agentTags.length > 0 ? agentTags : undefined,
      };

      // Resume
      if (params.resume) {
        const existing = manager.getRecord(params.resume);
        if (!existing) return textResult(`Agent not found: "${params.resume}". It may have been cleaned up.`);
        if (!existing.session) return textResult(`Agent "${params.resume}" has no active session to resume.`);
        const record = await manager.resume({ id: params.resume, prompt: params.prompt, signal });
        if (!record) return textResult(`Failed to resume agent "${params.resume}".`);
        return textResult(
          record.result?.trim() || record.error?.trim() || "No output.",
          buildDetails({ base: detailBase, record }),
        );
      }

      // Background
      if (runInBackground) {
        const { state: bgState, callbacks: bgCallbacks } = createActivityTracker(effectiveMaxTurns);
        let id: string;
        const origOnSession = bgCallbacks.onSessionCreated;
        bgCallbacks.onSessionCreated = (session: AgentSession) => {
          origOnSession(session);
          const rec = manager.getRecord(id);
          if (rec?.outputFile)
            rec.outputCleanup = streamToOutputFile({ session, path: rec.outputFile, agentId: id, cwd: ctx.cwd });
        };

        id = manager.spawn({
          pi,
          ctx,
          type: subagentType,
          prompt: params.prompt,
          options: {
            description: params.description,
            model,
            maxTurns: effectiveMaxTurns,
            isolated,
            inheritContext,
            thinkingLevel: thinking,
            isBackground: true,
            isolation,
            ...bgCallbacks,
          },
        });

        const joinMode = resolveJoinMode(batch.getDefaultJoinMode(), true);
        const record = manager.getRecord(id);
        if (record && joinMode) {
          record.isBackground = true;
          record.joinMode = joinMode;
          record.toolCallId = toolCallId;
          record.outputFile = createOutputFilePath({
            cwd: ctx.cwd,
            agentId: id,
            sessionId: ctx.sessionManager.getSessionId(),
          });
          writeInitialEntry({ path: record.outputFile, agentId: id, prompt: params.prompt, cwd: ctx.cwd });
        }

        if (joinMode != null && joinMode !== "async") batch.addToBatch(id, joinMode);
        agentActivity.set(id, bgState);
        widget.ensureTimer();
        widget.update();
        pi.events.emit("subagents:created", {
          id,
          type: subagentType,
          description: params.description,
          isBackground: true,
        });

        const isQueued = record?.status === "queued";
        return textResult(
          `Agent ${isQueued ? "queued" : "started"} in background.\nAgent ID: ${id}\nType: ${displayName}\nDescription: ${params.description}\n` +
            (isQueued ? `Position: queued (max ${manager.getMaxConcurrent()} concurrent)\n` : "") +
            "\nYou will be notified when this agent completes.\nUse get_subagent_result to retrieve full results, or steer_subagent to send it messages.\nDo not duplicate this agent's work.",
          { ...detailBase, toolUses: 0, tokens: "", durationMs: 0, status: "background" as const, agentId: id },
        );
      }

      // Foreground
      let spinnerFrame = 0;
      const startedAt = Date.now();
      let fgId: string | undefined;

      const streamUpdate = () => {
        const details: AgentDetails = {
          ...(detailBase as AgentDetails),
          toolUses: fgState.toolUses,
          tokens: fgState.tokens,
          turnCount: fgState.turnCount,
          maxTurns: fgState.maxTurns,
          durationMs: Date.now() - startedAt,
          status: "running",
          activity: describeActivity(fgState.activeTools, fgState.responseText),
          responseText: fgState.responseText,
          spinnerFrame: spinnerFrame % SPINNER.length,
        };
        onUpdate?.({ content: [{ type: "text", text: `${fgState.toolUses} tool uses...` }], details });
      };

      const { state: fgState, callbacks: fgCallbacks } = createActivityTracker(effectiveMaxTurns, streamUpdate);
      const origFgOnSession = fgCallbacks.onSessionCreated;
      fgCallbacks.onSessionCreated = (session: AgentSession) => {
        origFgOnSession(session);
        for (const a of manager.listAgents()) {
          if (a.session === session) {
            fgId = a.id;
            agentActivity.set(a.id, fgState);
            widget.ensureTimer();
            break;
          }
        }
      };

      const spinnerInterval = setInterval(() => {
        spinnerFrame++;
        streamUpdate();
      }, 80);
      streamUpdate();

      const record = await manager.spawnAndWait({
        pi,
        ctx,
        type: subagentType,
        prompt: params.prompt,
        options: {
          description: params.description,
          model,
          maxTurns: effectiveMaxTurns,
          isolated,
          inheritContext,
          thinkingLevel: thinking,
          isolation,
          ...fgCallbacks,
        },
      });
      clearInterval(spinnerInterval);

      if (fgId) {
        agentActivity.delete(fgId);
        widget.markFinished(fgId);
      }

      const tokenText = safeFormatTokens(fgState.session);
      const details = buildDetails({ base: detailBase, record, activity: fgState, overrides: { tokens: tokenText } });
      const fallbackNote = fellBack ? `Note: Unknown agent type "${rawType}" — using general-purpose.\n\n` : "";

      if (record.status === "error") return textResult(`${fallbackNote}Agent failed: ${record.error}`, details);

      const durationMs = (record.completedAt ?? Date.now()) - record.startedAt;
      const statsParts = [`${record.toolUses} tool uses`];
      if (tokenText) statsParts.push(tokenText);
      return textResult(
        `${fallbackNote}Agent completed in ${formatMs(durationMs)} (${statsParts.join(", ")})${getStatusNote(record.status)}.\n\n` +
          (record.result?.trim() || "No output."),
        details,
      );
    },
  });
}
