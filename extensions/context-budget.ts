/**
 * Context Budget Extension
 *
 * Shows context token usage in the footer and warns when approaching
 * the 40% and 60% thresholds where subagent offloading is recommended.
 *
 * Status format:
 *   ctx:12%           — healthy, no action needed
 *   ctx:43% → subagent  — at 40% threshold, consider offloading
 *   ctx:61% ⚠ offload   — at 60% threshold, actively offload
 */
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

const WARN_THRESHOLD = 0.4;  // 40% — start offloading
const HIGH_THRESHOLD = 0.6;  // 60% — actively offload

function formatPct(ratio: number): string {
	return `${Math.round(ratio * 100)}%`;
}

export default function contextBudget(pi: ExtensionAPI) {
	function update(ctx: Parameters<Parameters<ExtensionAPI["on"]>[1]>[1]) {
		if (!ctx.hasUI) return;
		try {
			const usage = ctx.getContextUsage();
			if (!usage || !usage.contextWindow) {
				ctx.ui.setStatus("context", undefined);
				return;
			}
			// percent is 0-100 or null (null means tokens unknown, e.g. right after compaction)
			if (usage.percent === null) {
				ctx.ui.setStatus("context", undefined);
				return;
			}
			const ratio = usage.percent / 100;
			const pct = formatPct(ratio);
			if (ratio >= HIGH_THRESHOLD) {
				ctx.ui.setStatus("context", `ctx:${pct} ⚠ offload`);
			} else if (ratio >= WARN_THRESHOLD) {
				ctx.ui.setStatus("context", `ctx:${pct} → subagent`);
			} else {
				ctx.ui.setStatus("context", `ctx:${pct}`);
			}
		} catch {
			// Context usage may not be available — ignore silently
		}
	}

	pi.on("turn_end", async (_event, ctx) => { update(ctx); });
	pi.on("agent_end", async (_event, ctx) => { update(ctx); });

	pi.on("session_switch", async (_event, ctx) => {
		if (!ctx.hasUI) return;
		ctx.ui.setStatus("context", undefined);
	});
}
