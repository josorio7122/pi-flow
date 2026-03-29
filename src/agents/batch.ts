/**
 * Batch tracking for smart join mode.
 *
 * Collects background agent IDs spawned in the current turn.
 * Uses a debounced timer so parallel tool calls dispatched across
 * multiple event loop ticks are captured in the same batch.
 */

import type { GroupJoinManager } from "../extension/group-join.js";
import type { AgentRecord, JoinMode } from "../types.js";
import type { AgentManager } from "./manager.js";

export function createBatchSystem({
  groupJoin,
  manager,
  notifications,
}: {
  groupJoin: GroupJoinManager;
  manager: AgentManager;
  notifications: { sendIndividualNudge: (record: AgentRecord) => void };
}) {
  let currentBatchAgents: { id: string; joinMode: JoinMode }[] = [];
  let batchFinalizeTimer: ReturnType<typeof setTimeout> | undefined;
  let batchCounter = 0;
  let defaultJoinMode: JoinMode = "smart";

  function finalizeBatch() {
    batchFinalizeTimer = undefined;
    const batchAgents = [...currentBatchAgents];
    currentBatchAgents = [];

    const smartAgents = batchAgents.filter((a) => a.joinMode === "smart" || a.joinMode === "group");
    if (smartAgents.length >= 2) {
      const groupId = `batch-${++batchCounter}`;
      const ids = smartAgents.map((a) => a.id);
      groupJoin.registerGroup(groupId, ids);
      for (const id of ids) {
        const record = manager.getRecord(id);
        if (!record) continue;
        record.groupId = groupId;
        if (record.completedAt != null && !record.resultConsumed) {
          groupJoin.onAgentComplete(record);
        }
      }
    } else {
      for (const { id } of batchAgents) {
        const record = manager.getRecord(id);
        if (record?.completedAt != null && !record.resultConsumed) {
          notifications.sendIndividualNudge(record);
        }
      }
    }
  }

  function addToBatch(id: string, joinMode: JoinMode) {
    currentBatchAgents.push({ id, joinMode });
    if (batchFinalizeTimer) clearTimeout(batchFinalizeTimer);
    batchFinalizeTimer = setTimeout(finalizeBatch, 100);
  }

  function isInBatch(id: string) {
    return currentBatchAgents.some((a) => a.id === id);
  }

  function getDefaultJoinMode() {
    return defaultJoinMode;
  }

  function setDefaultJoinMode(mode: JoinMode) {
    defaultJoinMode = mode;
  }

  return { addToBatch, isInBatch, getDefaultJoinMode, setDefaultJoinMode };
}

export type BatchSystem = ReturnType<typeof createBatchSystem>;
