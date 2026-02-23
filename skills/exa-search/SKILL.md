---
name: exa-search
description: Neural web search, content extraction, similar-page discovery, and direct AI answers via Exa API. Prefer over brave-search when semantic/conceptual search is needed, when you need AI-generated answers with citations, or when finding pages similar to a known URL.
compatibility: Requires EXA_API_KEY env var and npx tsx (Node.js)
metadata:
  author: josorio7122
  version: "1.0"
---

# Exa Search

Neural web search and content retrieval using the Exa API. Unlike keyword-based search, Exa uses embeddings to find semantically relevant content. No browser or HTML scraping required — content is returned clean by the API.

## Setup

1. Create an account at https://dashboard.exa.ai
2. Generate an API key under API Keys
3. Add to your shell profile (`~/.zprofile` or `~/.profile`):
   ```bash
   export EXA_API_KEY="your-api-key-here"
   ```
4. Install dependencies (run once):
   ```bash
   cd {baseDir}
   npm install
   ```

---

## Search

```bash
{baseDir}/search.ts "query"                                  # Basic neural search (5 results)
{baseDir}/search.ts "query" -n 10                            # More results (max 20)
{baseDir}/search.ts "query" --content                        # Include full page text
{baseDir}/search.ts "query" --highlights                     # Include content highlights (shorter)
{baseDir}/search.ts "query" --summary                        # Include AI summary per result
{baseDir}/search.ts "query" --type keyword                   # Force keyword (BM25) search
{baseDir}/search.ts "query" --type neural                    # Force semantic/neural search
{baseDir}/search.ts "query" --category news                  # Filter by category
{baseDir}/search.ts "query" --domain github.com              # Restrict to one domain
{baseDir}/search.ts "query" --after 2025-01-01               # Results after date
{baseDir}/search.ts "query" --before 2025-06-01              # Results before date
{baseDir}/search.ts "query" -n 3 --highlights --after 2025-01-01  # Combined
```

### Options

- `-n <num>` — Number of results (default: 5, max: 20)
- `--type <type>` — `auto` (default), `neural` (semantic), `keyword` (BM25)
- `--content` — Full page text (up to 5000 chars per result)
- `--highlights` — 3 key highlight sentences per result (lighter than `--content`)
- `--summary` — AI-generated summary of each result
- `--category <cat>` — Filter by type: `news`, `tweet`, `github`, `pdf`, `paper`, `company`, `research report`, `linkedin profile`, `financial report`
- `--domain <domain>` — Only return results from this domain
- `--after <YYYY-MM-DD>` — Only results published after this date
- `--before <YYYY-MM-DD>` — Only results published before this date

---

## Find Similar Pages

Find pages semantically similar in meaning to a known URL. Unique to Exa.

```bash
{baseDir}/similar.ts https://example.com/article              # Find similar pages
{baseDir}/similar.ts https://example.com/article -n 8         # More results
{baseDir}/similar.ts https://github.com/vercel/next.js --highlights
{baseDir}/similar.ts https://example.com --summary --exclude-source
```

### Options

- `-n <num>` — Number of results (default: 5)
- `--content` — Include full text
- `--highlights` — Include highlights
- `--summary` — Include AI summary
- `--exclude-source` — Exclude the source domain from results

---

## Fetch Page Content

Get clean, pre-parsed text from one or more URLs via Exa's content API. No HTML scraping needed.

```bash
{baseDir}/content.ts https://example.com/article
{baseDir}/content.ts https://example.com/article --summary
{baseDir}/content.ts https://site1.com/page https://site2.com/page
{baseDir}/content.ts https://example.com/article --highlights
```

### Options

- `--highlights` — Return highlights instead of full text
- `--summary` — Include AI-generated summary

---

## Direct Answers

Get an AI-generated answer to a question, grounded in live web results with citations.

```bash
{baseDir}/answer.ts "What is the latest stable version of Node.js?"
{baseDir}/answer.ts "How does React Server Components work?"
{baseDir}/answer.ts "What are the main differences between Bun and Deno?"
```

Returns the answer followed by numbered source citations.

---

## Output Format

```
--- Result 1 ---
Title: Page Title
Link: https://example.com/page
Published: 2025-01-15
Author: Jane Doe
Score: 0.8732
Summary:
  AI-generated summary of the page...
Highlights:
  • Key sentence from the content
  • Another key sentence
Content:
  Full page text (if --content used)...

--- Result 2 ---
...
```

---

## When to Use Exa vs Brave Search

| Scenario | Use |
|---|---|
| Semantic / conceptual query ("pages about X idea") | **Exa** (`--type neural`) |
| Exact keyword / phrase match | Brave or Exa `--type keyword` |
| Find pages similar to a known URL | **Exa** `similar.ts` |
| Get a direct answer with citations | **Exa** `answer.ts` |
| Filter by content type (papers, tweets, GitHub) | **Exa** `--category` |
| Fetch content from a URL without scraping | **Exa** `content.ts` |
| General web search, news, country-specific results | Brave |
