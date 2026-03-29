/**
 * steer_subagent tool — send a steering message to a running agent.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { textResult } from "../../extension/helpers.js";
import type { AgentManager } from "../manager.js";
import { steerAgent } from "../runner.js";

export function registerSteerTool({ pi, manager }: { pi: ExtensionAPI; manager: AgentManager }) {
  pi.registerTool({
    name: "steer_subagent",
    label: "Steer Agent",
    description:
      "Send a steering message to a running agent. The message will interrupt the agent after its current tool execution " +
      "and be injected into its conversation, allowing you to redirect its work mid-run. Only works on running agents.",
    parameters: Type.Object({
      agent_id: Type.String({ description: "The agent ID to steer (must be currently running)." }),
      message: Type.String({ description: "The steering message to send." }),
    }),
    execute: async (_, params) => {
      const record = manager.getRecord(params.agent_id);
      if (!record) {
        return textResult(`Agent not found: "${params.agent_id}". It may have been cleaned up.`);
      }
      if (record.status !== "running") {
        return textResult(
          `Agent "${params.agent_id}" is not running (status: ${record.status}). Cannot steer a non-running agent.`,
        );
      }
      if (!record.session) {
        if (!record.pendingSteers) record.pendingSteers = [];
        record.pendingSteers.push(params.message);
        pi.events.emit("subagents:steered", { id: record.id, message: params.message });
        return textResult(
          `Steering message queued for agent ${record.id}. It will be delivered once the session initializes.`,
        );
      }

      try {
        await steerAgent(record.session, params.message);
        pi.events.emit("subagents:steered", { id: record.id, message: params.message });
        return textResult(
          `Steering message sent to agent ${record.id}. The agent will process it after its current tool execution.`,
        );
      } catch (err) {
        return textResult(`Failed to steer agent: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
  });
}
