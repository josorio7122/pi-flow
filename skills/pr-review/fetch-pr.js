#!/usr/bin/env node

/**
 * fetch-pr.js <github-pr-url>
 *
 * Fetches all PR data via the GitHub CLI (gh) and outputs structured markdown:
 *   - Metadata (title, author, branches, stats)
 *   - Full diff
 *   - All issue comments
 *   - All review comments (inline, with file + line context)
 *   - All reviews (state + body)
 *   - CI check status
 *
 * Supports:
 *   https://github.com/owner/repo/pull/123
 *   owner/repo#123
 */

import { execSync } from "node:child_process";
import { writeFileSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const MAX_DIFF_BYTES = 50 * 1024; // 50KB

function die(msg) {
	console.error(`Error: ${msg}`);
	process.exit(1);
}

function gh(args) {
	try {
		return execSync(`gh ${args}`, { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] });
	} catch (e) {
		die(`gh command failed: gh ${args}\n${e.stderr || e.message}`);
	}
}

function ghJson(args) {
	return JSON.parse(gh(args));
}

// Parse PR URL into { owner, repo, number }
function parsePrUrl(input) {
	// https://github.com/owner/repo/pull/123
	const longMatch = input.match(/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/);
	if (longMatch) return { owner: longMatch[1], repo: longMatch[2], number: longMatch[3] };

	// owner/repo#123
	const shortMatch = input.match(/^([^/]+)\/([^#]+)#(\d+)$/);
	if (shortMatch) return { owner: shortMatch[1], repo: shortMatch[2], number: shortMatch[3] };

	die(`Cannot parse PR URL: ${input}\nSupported formats:\n  https://github.com/owner/repo/pull/123\n  owner/repo#123`);
}

// Check gh is installed and authenticated
function checkGh() {
	try {
		execSync("gh auth status", { stdio: "pipe" });
	} catch {
		die("GitHub CLI (gh) is not installed or not authenticated.\nInstall: https://cli.github.com\nAuth: gh auth login");
	}
}

function section(title) {
	return `\n${"=".repeat(60)}\n## ${title}\n${"=".repeat(60)}\n`;
}

async function main() {
	const input = process.argv[2];
	if (!input) {
		console.log("Usage: fetch-pr.js <github-pr-url>");
		console.log("\nExamples:");
		console.log("  fetch-pr.js https://github.com/owner/repo/pull/123");
		console.log("  fetch-pr.js owner/repo#123");
		process.exit(1);
	}

	checkGh();

	const { owner, repo, number } = parsePrUrl(input);
	const fullRepo = `${owner}/${repo}`;
	const prUrl = `https://github.com/${owner}/${repo}/pull/${number}`;

	let out = "";

	// ── Metadata ─────────────────────────────────────────────────────────────
	out += section("PR METADATA");
	const meta = ghJson(`pr view ${number} --repo ${fullRepo} --json title,body,author,baseRefName,headRefName,additions,deletions,changedFiles,state,isDraft,reviewRequests,labels,milestone,url`);
	out += `URL:           ${prUrl}\n`;
	out += `Title:         ${meta.title}\n`;
	out += `Author:        ${meta.author?.name ? `${meta.author.name} (@${meta.author.login})` : `@${meta.author?.login}`}\n`;
	out += `Branch:        ${meta.headRefName} → ${meta.baseRefName}\n`;
	out += `State:         ${meta.isDraft ? "DRAFT" : meta.state}\n`;
	out += `Changes:       +${meta.additions} -${meta.deletions} across ${meta.changedFiles} file(s)\n`;
	if (meta.labels?.length) out += `Labels:        ${meta.labels.map((l) => l.name).join(", ")}\n`;
	if (meta.milestone) out += `Milestone:     ${meta.milestone.title}\n`;
	if (meta.reviewRequests?.length) out += `Review requests: ${meta.reviewRequests.map((r) => r.login || r.name).join(", ")}\n`;
	out += `\n### Description\n\n${meta.body || "(no description)"}\n`;

	// ── CI Checks ─────────────────────────────────────────────────────────────
	out += section("CI CHECKS");
	try {
		const checks = gh(`pr checks ${number} --repo ${fullRepo}`);
		out += checks || "(no checks)\n";
	} catch {
		out += "(could not fetch CI checks)\n";
	}

	// ── Changed Files ─────────────────────────────────────────────────────────
	out += section("CHANGED FILES");
	const files = ghJson(`api repos/${fullRepo}/pulls/${number}/files`);
	for (const f of files) {
		out += `  ${f.status.padEnd(10)} +${f.additions}/-${f.deletions}  ${f.filename}\n`;
	}

	// ── Full Diff ─────────────────────────────────────────────────────────────
	out += section("FULL DIFF");
	const diff = gh(`pr diff ${number} --repo ${fullRepo}`);
	if (diff.length > MAX_DIFF_BYTES) {
		const tmpDir = mkdtempSync(join(tmpdir(), "pr-diff-"));
		const tmpFile = join(tmpDir, `pr-${owner}-${repo}-${number}.diff`);
		writeFileSync(tmpFile, diff);
		out += `[Diff truncated: ${Math.round(diff.length / 1024)}KB exceeds ${Math.round(MAX_DIFF_BYTES / 1024)}KB limit]\n`;
		out += `[Full diff saved to: ${tmpFile}]\n\n`;
		out += diff.slice(0, MAX_DIFF_BYTES);
		out += "\n... (truncated, see file above for full diff)\n";
	} else {
		out += diff;
	}

	// ── Issue Comments (timeline comments) ───────────────────────────────────
	out += section("PR COMMENTS (TIMELINE)");
	const issueComments = ghJson(`api repos/${fullRepo}/issues/${number}/comments`);
	if (issueComments.length === 0) {
		out += "(no comments)\n";
	} else {
		for (const c of issueComments) {
			out += `\n--- @${c.user.login} (${new Date(c.created_at).toISOString().slice(0, 10)}) ---\n`;
			out += `${c.body}\n`;
		}
	}

	// ── Review Comments (inline, with code context) ───────────────────────────
	out += section("REVIEW COMMENTS (INLINE)");
	const reviewComments = ghJson(`api repos/${fullRepo}/pulls/${number}/comments`);
	if (reviewComments.length === 0) {
		out += "(no inline review comments)\n";
	} else {
		for (const c of reviewComments) {
			out += `\n--- @${c.user.login} on ${c.path}`;
			if (c.line) out += ` line ${c.line}`;
			else if (c.original_line) out += ` line ${c.original_line}`;
			out += ` (${new Date(c.created_at).toISOString().slice(0, 10)}) ---\n`;
			if (c.diff_hunk) {
				out += "```diff\n" + c.diff_hunk + "\n```\n";
			}
			out += `Comment: ${c.body}\n`;
			if (c.in_reply_to_id) out += `(reply to comment #${c.in_reply_to_id})\n`;
		}
	}

	// ── Reviews ───────────────────────────────────────────────────────────────
	out += section("REVIEWS");
	const reviews = ghJson(`api repos/${fullRepo}/pulls/${number}/reviews`);
	if (reviews.length === 0) {
		out += "(no reviews)\n";
	} else {
		for (const r of reviews) {
			if (!r.body && r.state === "COMMENTED") continue; // skip empty comment placeholders
			out += `\n--- @${r.user.login} — ${r.state} (${new Date(r.submitted_at).toISOString().slice(0, 10)}) ---\n`;
			if (r.body) out += `${r.body}\n`;
		}
	}

	// ── Commits ───────────────────────────────────────────────────────────────
	out += section("COMMITS");
	const commits = ghJson(`pr view ${number} --repo ${fullRepo} --json commits`);
	for (const c of commits.commits || []) {
		const msg = c.messageHeadline || c.oid;
		const short = c.oid.slice(0, 8);
		const authors = (c.authors || []).map((a) => `@${a.login || a.name}`).join(", ");
		out += `  ${short}  ${msg}${authors ? `  (${authors})` : ""}\n`;
	}

	process.stdout.write(out);
}

main().catch((e) => {
	console.error(e.message);
	process.exit(1);
});
