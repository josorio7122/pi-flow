/**
 * PR Review Extension
 *
 * Detects GitHub PR URLs in prompts (matching the pr-review prompt template pattern),
 * shows a widget with PR title/author, and sets the session name automatically.
 *
 * Mirrors the pattern from prompt-url-widget.ts by badlogic.
 * Works hand-in-hand with ~/.pi/agent/prompts/pr-review.md
 */

import { DynamicBorder, type ExtensionAPI, type ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Container, Text } from "@mariozechner/pi-tui";

// Matches the prompt template trigger line: "You are given one or more GitHub PR URLs: <url>"
const PR_PROMPT_PATTERN = /^\s*You are given one or more GitHub PR URLs:\s*(\S+)/im;

type PrMatch = {
	url: string;
};

type PrMetadata = {
	title?: string;
	author?: {
		login?: string;
		name?: string | null;
	};
};

function extractPrMatch(prompt: string): PrMatch | undefined {
	const match = prompt.match(PR_PROMPT_PATTERN);
	if (match?.[1]) return { url: match[1].trim() };
	return undefined;
}

async function fetchPrMetadata(pi: ExtensionAPI, url: string): Promise<PrMetadata | undefined> {
	try {
		const result = await pi.exec("gh", ["pr", "view", url, "--json", "title,author"]);
		if (result.code !== 0 || !result.stdout) return undefined;
		return JSON.parse(result.stdout) as PrMetadata;
	} catch {
		return undefined;
	}
}

function formatAuthor(author?: PrMetadata["author"]): string | undefined {
	if (!author) return undefined;
	const name = author.name?.trim();
	const login = author.login?.trim();
	if (name && login) return `${name} (@${login})`;
	if (login) return `@${login}`;
	if (name) return name;
	return undefined;
}

export default function prReviewExtension(pi: ExtensionAPI) {
	const setWidget = (ctx: ExtensionContext, match: PrMatch, title?: string, authorText?: string) => {
		ctx.ui.setWidget("pr-review", (_tui, thm) => {
			const titleText = title ? thm.fg("accent", title) : thm.fg("accent", match.url);
			const lines: string[] = [titleText];
			if (authorText) lines.push(thm.fg("muted", authorText));
			lines.push(thm.fg("dim", match.url));

			const container = new Container();
			container.addChild(new DynamicBorder((s: string) => thm.fg("muted", s)));
			container.addChild(new Text(lines.join("\n"), 1, 0));
			return container;
		});
	};

	const applySessionName = (ctx: ExtensionContext, match: PrMatch, title?: string) => {
		const trimmedTitle = title?.trim();
		const fallbackName = `PR: ${match.url}`;
		const desiredName = trimmedTitle ? `PR: ${trimmedTitle} (${match.url})` : fallbackName;
		const currentName = pi.getSessionName()?.trim();
		if (!currentName) {
			pi.setSessionName(desiredName);
			return;
		}
		// Only overwrite if it's still the URL-only fallback (i.e. we now have a real title)
		if (currentName === match.url || currentName === fallbackName) {
			pi.setSessionName(desiredName);
		}
	};

	// Show widget and kick off metadata fetch as soon as the user submits a PR prompt
	pi.on("before_agent_start", async (event, ctx) => {
		if (!ctx.hasUI) return;
		const match = extractPrMatch(event.prompt);
		if (!match) return;

		setWidget(ctx, match);
		applySessionName(ctx, match);

		void fetchPrMetadata(pi, match.url).then((meta) => {
			const title = meta?.title?.trim();
			const authorText = formatAuthor(meta?.author);
			setWidget(ctx, match, title, authorText);
			applySessionName(ctx, match, title);
		});
	});

	// Restore widget when switching sessions
	pi.on("session_switch", async (_event, ctx) => {
		rebuildFromSession(ctx);
	});

	// Restore widget on startup (e.g. resuming a session)
	pi.on("session_start", async (_event, ctx) => {
		rebuildFromSession(ctx);
	});

	const getUserText = (content: string | { type: string; text?: string }[] | undefined): string => {
		if (!content) return "";
		if (typeof content === "string") return content;
		return content
			.filter((block): block is { type: "text"; text: string } => block.type === "text")
			.map((block) => block.text)
			.join("\n");
	};

	const rebuildFromSession = (ctx: ExtensionContext) => {
		if (!ctx.hasUI) return;

		const entries = ctx.sessionManager.getEntries();
		const lastMatch = [...entries].reverse().find((entry) => {
			if (entry.type !== "message" || entry.message.role !== "user") return false;
			const text = getUserText(entry.message.content);
			return !!extractPrMatch(text);
		});

		const content =
			lastMatch?.type === "message" && lastMatch.message.role === "user" ? lastMatch.message.content : undefined;
		const text = getUserText(content);
		const match = text ? extractPrMatch(text) : undefined;
		if (!match) {
			ctx.ui.setWidget("pr-review", undefined);
			return;
		}

		setWidget(ctx, match);
		applySessionName(ctx, match);
		void fetchPrMetadata(pi, match.url).then((meta) => {
			const title = meta?.title?.trim();
			const authorText = formatAuthor(meta?.author);
			setWidget(ctx, match, title, authorText);
			applySessionName(ctx, match, title);
		});
	};
}
