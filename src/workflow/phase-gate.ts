/**
 * Gate phase — pause execution and wait for user approval.
 */

import type { PhaseDefinition, WorkflowEvent } from "./types.js";

export function executeGatePhase({
  phase,
  emitEvent,
}: {
  phase: PhaseDefinition;
  emitEvent: (event: WorkflowEvent) => void;
}) {
  emitEvent({ type: "phase_start", phase: phase.name, ts: Date.now() });
  return { type: "gate-waiting", phase: phase.name };
}
