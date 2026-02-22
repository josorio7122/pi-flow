#!/usr/bin/env node

// Fetch clean, parsed content from one or more URLs via Exa's content API.
// No HTML scraping — Exa returns pre-cleaned markdown-ready text.

import Exa from "exa-js";

const args = process.argv.slice(2);

function extractFlag(flag) {
	const i = args.indexOf(flag);
	if (i === -1) return false;
	args.splice(i, 1);
	return true;
}

const withHighlights = extractFlag("--highlights");
const withSummary    = extractFlag("--summary");

const urls = args.filter(a => a.startsWith("http"));

if (urls.length === 0) {
	console.log("Usage: content.js <url> [url2 ...] [options]");
	console.log("\nFetches clean text content from one or more URLs via Exa.");
	console.log("\nOptions:");
	console.log("  --highlights   Include content highlights instead of full text");
	console.log("  --summary      Include AI-generated summary");
	console.log("\nEnvironment:");
	console.log("  EXA_API_KEY    Required. Your Exa API key.");
	console.log("\nExamples:");
	console.log("  content.js https://example.com/article");
	console.log("  content.js https://example.com/article --summary");
	console.log("  content.js https://site1.com/page https://site2.com/page");
	process.exit(1);
}

const apiKey = process.env.EXA_API_KEY;
if (!apiKey) {
	console.error("Error: EXA_API_KEY environment variable is not set.");
	console.error("Get your API key at: https://dashboard.exa.ai/api-keys");
	process.exit(1);
}

const exa = new Exa(apiKey);

try {
	const contentsOpts = {
		...(!withHighlights && { text: { maxCharacters: 10000 } }),
		...(withHighlights && { highlights: { numSentences: 5, highlightsPerUrl: 5 } }),
		...(withSummary    && { summary: true }),
	};

	const res = await exa.getContents(urls, contentsOpts);

	if (!res.results || res.results.length === 0) {
		console.log("No content returned.");
		process.exit(0);
	}

	for (let i = 0; i < res.results.length; i++) {
		const r = res.results[i];
		if (res.results.length > 1) console.log(`--- ${r.url} ---\n`);

		if (r.title)         console.log(`# ${r.title}\n`);
		if (r.author)        console.log(`Author: ${r.author}`);
		if (r.publishedDate) console.log(`Published: ${r.publishedDate.slice(0, 10)}\n`);

		if (r.summary)    console.log(`Summary:\n${r.summary}\n`);
		if (r.highlights) console.log(`Highlights:\n${r.highlights.map(h => `  • ${h}`).join("\n")}\n`);
		if (r.text)       console.log(r.text.trim());

		if (i < res.results.length - 1) console.log("\n");
	}
} catch (e) {
	console.error(`Error: ${e.message}`);
	process.exit(1);
}
