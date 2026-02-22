/**
 * Workflow Status Extension
 *
 * Shows the current workflow phase in the footer status bar.
 * Detects phase transitions by watching for skill announcement patterns
 * in assistant messages.
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

const PHASE_PATTERNS: Array<{ pattern: RegExp; phase: Phase }> = [
	{ pattern: /using the research skill/i, phase: "research" },
	{ pattern: /using the understand-codebase skill/i, phase: "understand" },
	{ pattern: /using the brainstorming skill/i, phase: "brainstorm" },
	{ pattern: /using the spec-writer skill/i, phase: "spec" },
	{ pattern: /using the writing-plans skill/i, phase: "plan" },
	{ pattern: /using the subagent-driven-development skill/i, phase: "execute" },
	{ pattern: /using the pr-review skill/i, phase: "review" },
	{ pattern: /final review.*implementation/i, phase: "review" },
	{ pattern: /using the finishing-a-development-branch skill/i, phase: "ship" },
];

// Greenfield starts with research, existing starts with understand.
// The bar is set once the first phase is detected and stays on that path.
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

function extractText(content: unknown): string {
	if (!content) return "";
	if (typeof content === "string") return content;
	if (Array.isArray(content)) {
		return content
			.filter((b): b is { type: "text"; text: string } => typeof b === "object" && b !== null && (b as { type: string }).type === "text")
			.map((b) => b.text)
			.join(" ");
	}
	return "";
}

function detectPhase(text: string): Phase | null {
	for (const { pattern, phase } of PHASE_PATTERNS) {
		if (pattern.test(text)) return phase;
	}
	return null;
}

function resolvePath(phase: Phase, lockedPath: Phase[] | null): Phase[] {
	if (lockedPath) return lockedPath;
	// Lock to greenfield if research is first, existing if understand is first
	if (phase === "research") return GREENFIELD;
	if (phase === "understand") return EXISTING;
	// For any other first-detected phase, default to existing path
	return EXISTING;
}

export default function workflowStatus(pi: ExtensionAPI) {
	let lockedPath: Phase[] | null = null;

	// Watch assistant messages for skill announcements
	pi.on("message_end", async (event, ctx) => {
		if (!ctx.hasUI) return;
		const msg = event.message;
		if (msg.role !== "assistant") return;
		const text = extractText(msg.content);
		const detected = detectPhase(text);
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

	// Restore on session load — scan all messages for last known phase
	pi.on("session_start", async (_event, ctx) => {
		if (!ctx.hasUI) return;
		const entries = ctx.sessionManager.getEntries();
		let lastPhase: Phase = "idle";
		for (const entry of entries) {
			if (entry.type !== "message" || entry.message.role !== "assistant") continue;
			const text = extractText(entry.message.content);
			const detected = detectPhase(text);
			if (detected) {
				if (!lockedPath) lockedPath = resolvePath(detected, null);
				lastPhase = detected;
			}
		}
		if (lastPhase !== "idle" && lockedPath) {
			ctx.ui.setStatus("workflow", buildBar(lastPhase, lockedPath));
		}
	});
}
