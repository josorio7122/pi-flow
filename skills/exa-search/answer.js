#!/usr/bin/env node

// Get a direct AI-generated answer to a question, grounded in live web results.
// Unique to Exa — returns an answer + citations.

import Exa from "exa-js";

const query = process.argv.slice(2).join(" ").trim();

if (!query) {
	console.log("Usage: answer.js <question>");
	console.log("\nReturns a direct AI-generated answer grounded in live web sources.");
	console.log("\nEnvironment:");
	console.log("  EXA_API_KEY    Required. Your Exa API key.");
	console.log("\nExamples:");
	console.log('  answer.js "What is the latest version of Node.js?"');
	console.log('  answer.js "How does React Server Components work?"');
	console.log('  answer.js "What are the main differences between Bun and Deno?"');
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
	const res = await exa.answer(query, { text: true });

	console.log(`Q: ${query}\n`);
	console.log(`A: ${res.answer}\n`);

	if (res.citations && res.citations.length > 0) {
		console.log("Sources:");
		for (let i = 0; i < res.citations.length; i++) {
			const c = res.citations[i];
			console.log(`  [${i + 1}] ${c.title || "(no title)"}`);
			console.log(`      ${c.url}`);
			if (c.publishedDate) console.log(`      Published: ${c.publishedDate.slice(0, 10)}`);
		}
	}
} catch (e) {
	console.error(`Error: ${e.message}`);
	process.exit(1);
}
