#!/usr/bin/env node

// Find pages semantically similar to a given URL — unique to Exa.

import Exa from "exa-js";

const args = process.argv.slice(2);

function extractFlag(flag) {
	const i = args.indexOf(flag);
	if (i === -1) return false;
	args.splice(i, 1);
	return true;
}

function extractOption(flag) {
	const i = args.indexOf(flag);
	if (i === -1 || !args[i + 1]) return null;
	const val = args[i + 1];
	args.splice(i, 2);
	return val;
}

const fetchContent    = extractFlag("--content");
const fetchHighlights = extractFlag("--highlights");
const fetchSummary    = extractFlag("--summary");
const numResults      = parseInt(extractOption("-n") || "5", 10);
const excludeSource   = extractFlag("--exclude-source"); // exclude the source URL itself

const url = args[0];

if (!url || !url.startsWith("http")) {
	console.log("Usage: similar.js <url> [options]");
	console.log("\nFinds pages semantically similar in meaning to the given URL.");
	console.log("\nOptions:");
	console.log("  -n <num>          Number of results (default: 5)");
	console.log("  --content         Include full page text");
	console.log("  --highlights      Include content highlights");
	console.log("  --summary         Include AI-generated summary");
	console.log("  --exclude-source  Exclude the source URL from results");
	console.log("\nEnvironment:");
	console.log("  EXA_API_KEY       Required. Your Exa API key.");
	console.log("\nExamples:");
	console.log("  similar.js https://example.com/some-article");
	console.log("  similar.js https://github.com/vercel/next.js --highlights -n 8");
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
	const opts = {
		numResults: Math.min(numResults, 20),
		...(excludeSource && { excludeSourceDomain: true }),
	};

	let results;

	if (fetchContent || fetchHighlights || fetchSummary) {
		const res = await exa.findSimilarAndContents(url, {
			...opts,
			...(fetchContent    && { text: { maxCharacters: 5000 } }),
			...(fetchHighlights && { highlights: { numSentences: 3, highlightsPerUrl: 3 } }),
			...(fetchSummary    && { summary: true }),
		});
		results = res.results;
	} else {
		const res = await exa.findSimilar(url, opts);
		results = res.results;
	}

	if (!results || results.length === 0) {
		console.log("No similar pages found.");
		process.exit(0);
	}

	console.log(`Similar pages to: ${url}\n`);

	for (let i = 0; i < results.length; i++) {
		const r = results[i];
		console.log(`--- Result ${i + 1} ---`);
		console.log(`Title: ${r.title || "(no title)"}`);
		console.log(`Link: ${r.url}`);
		if (r.publishedDate) console.log(`Published: ${r.publishedDate.slice(0, 10)}`);
		if (r.author)        console.log(`Author: ${r.author}`);
		if (r.score != null) console.log(`Score: ${r.score.toFixed(4)}`);

		if (r.summary)    console.log(`Summary:\n${r.summary}`);
		if (r.highlights) console.log(`Highlights:\n${r.highlights.map(h => `  • ${h}`).join("\n")}`);
		if (r.text)       console.log(`Content:\n${r.text.trim()}`);

		console.log("");
	}
} catch (e) {
	console.error(`Error: ${e.message}`);
	process.exit(1);
}
