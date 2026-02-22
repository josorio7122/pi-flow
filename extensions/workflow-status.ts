/**
 * Workflow Status Extension
 *
 * Shows the current workflow phase in the footer status bar.
 * Detects phase transitions by watching for skill announcement patterns
 * in assistant messages.
 *
 * Phases: research → understand → brainstorm → spec → plan → execute → review
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
	| "review";

const PHASE_PATTERNS: Array<{ pattern: RegExp; phase: Phase }> = [
	{ pattern: /using the research skill/i, phase: "research" },
	{ pattern: /using the understand-codebase skill/i, phase: "understand" },
	{ pattern: /using the brainstorming skill/i, phase: "brainstorm" },
	{ pattern: /using the spec-writer skill/i, phase: "spec" },
	{ pattern: /using the writing-plans skill/i, phase: "plan" },
	{ pattern: /using the subagent-driven-development skill/i, phase: "execute" },
	{ pattern: /using the pr-review skill/i, phase: "review" },
	{ pattern: /final review.*implementation/i, phase: "review" },
];

const PHASE_ORDER: Phase[] = ["research", "understand", "brainstorm", "spec", "plan", "execute", "review"];
const PHASE_LABELS: Record<Phase, string> = {
	idle: "",
	research: "research",
	understand: "understand",
	brainstorm: "brainstorm",
	spec: "spec",
	plan: "plan",
	execute: "execute",
	review: "review",
};

function buildBar(current: Phase): string {
	if (current === "idle") return "";
	const curIdx = PHASE_ORDER.indexOf(current);
	return PHASE_ORDER.map((phase, idx) => {
		const label = PHASE_LABELS[phase];
		if (idx < curIdx) return `✓${label}`;
		if (idx === curIdx) return `[${label}]`;
		return label;
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

export default function workflowStatus(pi: ExtensionAPI) {
	// Watch assistant messages for skill announcements
	pi.on("message_end", async (event, ctx) => {
		if (!ctx.hasUI) return;
		const msg = event.message;
		if (msg.role !== "assistant") return;
		const text = extractText(msg.content);
		const detected = detectPhase(text);
		if (detected) ctx.ui.setStatus("workflow", buildBar(detected));
	});

	// Clear on new session
	pi.on("session_switch", async (_event, ctx) => {
		if (!ctx.hasUI) return;
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
			if (detected) lastPhase = detected;
		}
		if (lastPhase !== "idle") {
			ctx.ui.setStatus("workflow", buildBar(lastPhase));
		}
	});
}
