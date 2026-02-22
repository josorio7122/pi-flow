/**
 * Workflow Status Extension
 *
 * Shows the current workflow phase in the footer status bar.
 * Detects phase transitions by watching `read` tool calls on skill SKILL.md files.
 *
 * Only the phases relevant to the active workflow are shown:
 *   Greenfield:  research → brainstorm → spec → plan → execute → review → ship
 *   Existing:    understand → brainstorm → spec → plan → execute → review → ship
 *
 * Once a phase is detected the bar locks to that workflow path.
 * Active phase is shown in brackets: [brainstorm]
 * Past and future phases shown without decoration.
 */
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

type Phase =
	| "idle"
	| "research"
	| "understand"
	| "brainstorm"
	| "spec"
	| "plan"
	| "execute"
	| "review"
	| "ship";

// Map skill directory names (and key path segments) to phases.
// Matched against the path of any `read` tool call.
const SKILL_PHASE_MAP: Array<{ pattern: RegExp; phase: Phase }> = [
	{ pattern: /\/skills\/research\//i, phase: "research" },
	{ pattern: /\/skills\/understand-codebase\//i, phase: "understand" },
	{ pattern: /\/skills\/brainstorming\//i, phase: "brainstorm" },
	{ pattern: /\/skills\/spec-writer\//i, phase: "spec" },
	{ pattern: /\/skills\/writing-plans\//i, phase: "plan" },
	{ pattern: /\/skills\/subagent-driven-development\//i, phase: "execute" },
	{ pattern: /\/skills\/finishing-a-development-branch\//i, phase: "ship" },
	{ pattern: /\/skills\/pr-review\//i, phase: "review" },
];

// Greenfield starts with research, existing starts with understand.
// The bar is locked to a path once the first phase is detected.
const GREENFIELD: Phase[] = ["research", "brainstorm", "spec", "plan", "execute", "review", "ship"];
const EXISTING:   Phase[] = ["understand", "brainstorm", "spec", "plan", "execute", "review", "ship"];

function buildBar(current: Phase, path: Phase[]): string {
	const curIdx = path.indexOf(current);
	if (curIdx === -1) return `[${current}]`;
	return path.map((phase, idx) => {
		if (idx === curIdx) return `[${phase}]`;
		return phase;
	}).join(" → ");
}

function detectPhaseFromPath(path: string): Phase | null {
	for (const { pattern, phase } of SKILL_PHASE_MAP) {
		if (pattern.test(path)) return phase;
	}
	return null;
}

function resolvePath(phase: Phase, lockedPath: Phase[] | null): Phase[] {
	if (lockedPath) return lockedPath;
	if (phase === "research") return GREENFIELD;
	if (phase === "understand") return EXISTING;
	// Any other first-detected phase defaults to the existing codebase path
	return EXISTING;
}

export default function workflowStatus(pi: ExtensionAPI) {
	let lockedPath: Phase[] | null = null;

	// Watch read tool calls — detect when a skill file is being read
	pi.on("tool_call", async (event, ctx) => {
		if (!ctx.hasUI) return;
		if (event.toolName !== "read") return;
		const path = (event.input as { path?: string }).path ?? "";
		const detected = detectPhaseFromPath(path);
		if (!detected) return;
		lockedPath = resolvePath(detected, lockedPath);
		ctx.ui.setStatus("workflow", buildBar(detected, lockedPath));
	});

	// Clear on new session
	pi.on("session_switch", async (_event, ctx) => {
		if (!ctx.hasUI) return;
		lockedPath = null;
		ctx.ui.setStatus("workflow", undefined);
	});

	// Restore on session load — scan assistant messages for read tool calls on skill files
	pi.on("session_start", async (_event, ctx) => {
		if (!ctx.hasUI) return;
		const entries = ctx.sessionManager.getEntries();
		let lastPhase: Phase = "idle";

		for (const entry of entries) {
			if (entry.type !== "message") continue;
			const msg = entry.message;

			// AssistantMessages contain ToolCall content blocks with the arguments
			if (msg.role !== "assistant") continue;
			const content = Array.isArray(msg.content) ? msg.content : [];
			for (const block of content) {
				if (
					typeof block === "object" &&
					block !== null &&
					(block as { type: string }).type === "toolCall" &&
					(block as { name?: string }).name === "read"
				) {
					const args = (block as { arguments?: { path?: string } }).arguments ?? {};
					const path = args.path ?? "";
					const detected = detectPhaseFromPath(path);
					if (detected) {
						if (!lockedPath) lockedPath = resolvePath(detected, null);
						lastPhase = detected;
					}
				}
			}
		}

		if (lastPhase !== "idle" && lockedPath) {
			ctx.ui.setStatus("workflow", buildBar(lastPhase, lockedPath));
		}
	});
}
