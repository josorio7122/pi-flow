/**
 * group-join.ts — Manages grouped background agent completion notifications.
 *
 * Instead of each agent individually nudging the main agent on completion,
 * agents in a group are held until all complete (or a timeout fires),
 * then a single consolidated notification is sent.
 */

import type { AgentRecord } from "../types.js";

type DeliveryCallback = (records: AgentRecord[], partial: boolean) => void;

interface AgentGroup {
  groupId: string;
  agentIds: Set<string>;
  completedRecords: Map<string, AgentRecord>;
  timeoutHandle?: ReturnType<typeof setTimeout> | undefined;
  delivered: boolean;
  isStraggler: boolean;
}

/** Default timeout: 30s after first completion in a group. */
const DEFAULT_TIMEOUT = 30_000;
/** Straggler re-batch timeout: 15s. */
const STRAGGLER_TIMEOUT = 15_000;

interface GroupJoinState {
  groups: Map<string, AgentGroup>;
  agentToGroup: Map<string, string>;
}

type CompleteResult =
  | { action: "pass" }
  | { action: "held" }
  | { action: "deliver"; records: AgentRecord[]; partial: boolean };

/** Pure — register a group of agent IDs. */
function registerGroup(state: GroupJoinState, groupId: string, agentIds: string[]) {
  const group: AgentGroup = {
    groupId,
    agentIds: new Set(agentIds),
    completedRecords: new Map(),
    delivered: false,
    isStraggler: false,
  };
  state.groups.set(groupId, group);
  for (const id of agentIds) {
    state.agentToGroup.set(id, groupId);
  }
}

/** Pure — process an agent completion, return what action should be taken. */
function processCompletion(state: GroupJoinState, record: AgentRecord): CompleteResult {
  const groupId = state.agentToGroup.get(record.id);
  if (!groupId) return { action: "pass" };

  const group = state.groups.get(groupId);
  if (!group || group.delivered) return { action: "pass" };

  group.completedRecords.set(record.id, record);

  if (group.completedRecords.size >= group.agentIds.size) {
    return { action: "deliver", records: [...group.completedRecords.values()], partial: false };
  }

  return { action: "held" };
}

/** Pure — process a timeout, return partial delivery result. */
function processTimeout(state: GroupJoinState, groupId: string): CompleteResult {
  const group = state.groups.get(groupId);
  if (!group || group.delivered) return { action: "pass" };

  const records = [...group.completedRecords.values()];

  // Clean up delivered agents
  for (const id of group.completedRecords.keys()) {
    state.agentToGroup.delete(id);
  }

  // Set up straggler group for remaining
  const remaining = new Set<string>();
  for (const id of group.agentIds) {
    if (!group.completedRecords.has(id)) remaining.add(id);
  }
  group.completedRecords.clear();
  group.agentIds = remaining;
  group.isStraggler = true;

  return { action: "deliver", records, partial: true };
}

/** Pure — mark a group as fully delivered and clean up state. */
function markDelivered(state: GroupJoinState, groupId: string) {
  const group = state.groups.get(groupId);
  if (!group) return;
  if (group.timeoutHandle) {
    clearTimeout(group.timeoutHandle);
    group.timeoutHandle = undefined;
  }
  group.delivered = true;
  for (const id of group.agentIds) {
    state.agentToGroup.delete(id);
  }
  state.groups.delete(groupId);
}

/** Check if an agent is in a group. */
function isGrouped(state: GroupJoinState, agentId: string) {
  return state.agentToGroup.has(agentId);
}

/** Impure shell — wraps pure functions with timeout scheduling. */
export function createGroupJoinManager(deliverCb: DeliveryCallback, groupTimeout = DEFAULT_TIMEOUT) {
  const state: GroupJoinState = {
    groups: new Map(),
    agentToGroup: new Map(),
  };

  function scheduleTimeout(groupId: string, timeout: number) {
    const group = state.groups.get(groupId);
    if (!group || group.timeoutHandle) return;
    group.timeoutHandle = setTimeout(() => {
      const result = processTimeout(state, groupId);
      if (result.action === "deliver") {
        deliverCb(result.records, result.partial);
      }
    }, timeout);
  }

  return {
    registerGroup: (groupId: string, agentIds: string[]) =>
      registerGroup(state, groupId, agentIds),

    onAgentComplete: (record: AgentRecord): "delivered" | "held" | "pass" => {
      const result = processCompletion(state, record);
      if (result.action === "deliver") {
        const groupId = state.agentToGroup.get(record.id);
        if (groupId) markDelivered(state, groupId);
        deliverCb(result.records, result.partial);
        return "delivered";
      }
      if (result.action === "held") {
        const groupId = state.agentToGroup.get(record.id)!;
        const group = state.groups.get(groupId);
        const timeout = group?.isStraggler ? STRAGGLER_TIMEOUT : groupTimeout;
        scheduleTimeout(groupId, timeout);
        return "held";
      }
      return "pass";
    },

    isGrouped: (agentId: string) => isGrouped(state, agentId),

    dispose: () => {
      for (const group of state.groups.values()) {
        if (group.timeoutHandle) clearTimeout(group.timeoutHandle);
      }
      state.groups.clear();
      state.agentToGroup.clear();
    },
  };
}

export type GroupJoinManager = ReturnType<typeof createGroupJoinManager>;
