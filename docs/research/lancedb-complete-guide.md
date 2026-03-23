# LanceDB — Complete Guide (March 2026)

Date captured: 2026-03-23
Sources: Official docs, GitHub, blog posts, community plugins

---

## What It Is

An open-source **"SQLite for vectors"** — an embedded multimodal vector database built on the Lance columnar format. No server to run, no infrastructure to manage. Just a library.

- **v0.27.0** (TypeScript), **v0.30.1** (Python) — March 2026
- **9,612 GitHub stars**, Apache 2.0 license
- **Founded:** Feb 2023 by Chang She & Lei Xu, Series A $20M (Khosla Ventures)
- **Three deployment modes:** OSS (embedded/free), Cloud (managed SaaS), Enterprise (self-hosted)

---

## Why It Matters for Agent Memory

LanceDB is the most natural memory layer for AI agents because:

1. **Embedded** — no separate database process. Memory works by default through a library import.
2. **Local-first** — data stays on-device as `*.lance` files. No cloud dependency.
3. **Hybrid search** — vector similarity + BM25 full-text + SQL filters in one query.
4. **Multimodal** — stores vectors, text, images, audio, video natively.
5. **Versioned** — ACID transactions, time-travel queries, zero-copy branching.
6. **TypeScript/Python/Rust** — first-class SDKs for all three.

---

## Core Architecture

### Lance Format (Underlying Storage)

- Columnar, fragment-based (~1GB fragments), immutable, append-only
- **100x faster** than Parquet for random access; parity on scans
- Automatic versioning — every write creates a new version
- Fragment-level indexing + pruning for parallel ops
- Separate project: `lance-format/lance` (6,192 stars, Rust)

### Vector Search Algorithms

| Algorithm | Latency | Recall | Memory | Best For |
|-----------|---------|--------|--------|---------|
| **IVF-PQ** | <1ms | 85% | ~10% | Default choice, balanced |
| **IVF-HNSW** | ~2ms | 95% | ~15% | High recall needed |
| **DiskANN** | ~5ms | 90% | Minimal | Disk-optimized, huge datasets |
| **Flat** | ~50ms | 100% | 100% | Small datasets (<100K), exact match |

### Hybrid Search (Signature Feature)

Vector + BM25 full-text + SQL in one query:

```python
results = table.search([0.1, 0.5])
    .where("price < 100 AND category = 'electronics'")
    .rerank(ColBERT())
    .limit(10)
    .to_list()
```

Reranking options: LinearCombination (default), ColBERT, Cohere, CrossEncoder, RRF.

---

## Quick Start

### Python

```python
import lancedb

# Connect (creates directory if needed)
db = lancedb.connect("./my-db")

# Create table from list of dicts
data = [
    {"text": "hello world", "vector": [0.1, 0.2, 0.3]},
    {"text": "goodbye world", "vector": [0.4, 0.5, 0.6]},
]
table = db.create_table("my_table", data)

# Vector search
results = table.search([0.1, 0.2, 0.3]).limit(5).to_list()

# Full-text search
table.create_fts_index("text")
results = table.search("hello").limit(5).to_list()

# Hybrid search
results = table.search("hello", query_type="hybrid").limit(5).to_list()
```

### TypeScript

```typescript
import * as lancedb from "@lancedb/lancedb";

// Connect
const db = await lancedb.connect("./my-db");

// Create table
const data = [
  { text: "hello world", vector: [0.1, 0.2, 0.3] },
  { text: "goodbye world", vector: [0.4, 0.5, 0.6] },
];
const table = await db.createTable("my_table", data);

// Vector search
const results = await table.search([0.1, 0.2, 0.3]).limit(5).toArray();

// FTS search
await table.createIndex("text", { config: lancedb.Index.fts() });
const ftsResults = await table.search("hello", "fts").limit(5).toArray();

// Filtered search
const filtered = await table
  .search([0.1, 0.2, 0.3])
  .where("category = 'docs'")
  .limit(5)
  .toArray();
```

---

## Auto-Embedding

Register an embedding provider once, then forget about vectors:

### Python

```python
from lancedb.pydantic import LanceModel, Vector
from lancedb.embeddings import get_registry

# Register OpenAI embeddings
embedder = get_registry().get("openai").create(name="text-embedding-3-small")

class Document(LanceModel):
    text: str = embedder.SourceField()
    vector: Vector(1536) = embedder.VectorField()

# Insert — embedding happens automatically
table = db.create_table("docs", schema=Document)
table.add([{"text": "LanceDB is awesome"}])

# Search — query embedding happens automatically
results = table.search("what is LanceDB?").limit(5).to_list()
```

### Supported Embedding Providers

| Provider | Model | Dims | Cost |
|----------|-------|------|------|
| **OpenAI** | text-embedding-3-small | 1536 | $0.02/1M tokens |
| **Sentence Transformers** | all-MiniLM-L6-v2 | 384 | Free (local) |
| **Cohere** | embed-english-v3.0 | 1024 | Free tier |
| **Jina** | jina-embeddings-v5 | 1024 | Free tier |
| **Ollama** | nomic-embed-text | 768 | Free (local) |
| **Google** | gemini-embedding-001 | 3072 | Free tier |
| **HuggingFace** | BGE, E5, etc. | varies | Free (local) |

---

## Indexing

### When to Create Indexes

| Dataset Size | Index Strategy |
|-------------|---------------|
| <100K rows | No index needed (flat/brute force fast enough) |
| 100K-1M | IVF-PQ (128 partitions) |
| 1M-10M | IVF-PQ (256-512 partitions, 96 sub-vectors) |
| 10M+ | IVF-PQ (1024 partitions) or DiskANN |

### Creating Indexes

```python
# Vector index (IVF-PQ)
table.create_index(
    metric="cosine",
    num_partitions=256,
    num_sub_vectors=96
)

# Full-text index
table.create_fts_index("text")

# Scalar index (for filtering)
table.create_scalar_index("category")  # BTree
table.create_scalar_index("tags", index_type="BITMAP")  # Bitmap for low-cardinality
```

### Query-Time Tuning

```python
# nprobes controls speed/recall trade-off
results = table.search(query)
    .nprobes(20)    # default 10; higher = slower but better recall
    .limit(10)
    .to_list()
```

---

## Hybrid Search Patterns

### Vector + Full-Text (BM25)

```python
# Default: 70% vector, 30% BM25
results = table.search("machine learning", query_type="hybrid")
    .limit(10)
    .to_list()

# Custom weights
from lancedb.rerankers import LinearCombinationReranker
reranker = LinearCombinationReranker(weight=0.5)  # 50/50 split
results = table.search("query", query_type="hybrid")
    .rerank(reranker)
    .limit(10)
    .to_list()
```

### Reranking Options

| Reranker | How | Best For |
|----------|-----|---------|
| **LinearCombination** | Weighted blend of vector + BM25 scores | Default, fast |
| **RRF** | Reciprocal Rank Fusion | Balancing different score distributions |
| **CrossEncoder** | Neural model re-scores top-K | Highest quality, slower |
| **Cohere** | Cohere Rerank API | Production, API-based |
| **ColBERT** | Late interaction model | Token-level matching |

### Filtered Search

```python
# SQL WHERE clause applied before vector search
results = table.search(query_vector)
    .where("category = 'docs' AND date > '2026-01-01'")
    .limit(10)
    .to_list()
```

---

## Data Management

### CRUD Operations

```python
# Add rows
table.add([{"text": "new doc", "vector": [...]}])

# Update
table.update(where="id = 5", values={"text": "updated"})

# Delete
table.delete("category = 'deprecated'")

# Merge (upsert)
table.merge_insert("id")
    .when_matched_update_all()
    .when_not_matched_insert_all()
    .execute(new_data)
```

### Versioning

```python
# List versions
versions = table.list_versions()

# Time-travel query
table.checkout(version=3)
old_results = table.search(query).to_list()
table.restore()  # back to latest

# Checkout by timestamp
table.checkout_version(as_of="2026-03-01T00:00:00Z")
```

### Compaction & Cleanup

```python
# Compact small fragments into larger ones
table.compact_files()

# Remove old versions (keep last 5)
table.cleanup_old_versions(older_than=timedelta(days=7), delete_unverified=True)
```

---

## RAG Pipeline Pattern

```python
import lancedb
from lancedb.pydantic import LanceModel, Vector
from lancedb.embeddings import get_registry

# 1. Setup
embedder = get_registry().get("openai").create(name="text-embedding-3-small")

class Chunk(LanceModel):
    text: str = embedder.SourceField()
    vector: Vector(1536) = embedder.VectorField()
    source: str
    page: int

db = lancedb.connect("./rag-db")
table = db.create_table("chunks", schema=Chunk)

# 2. Chunk & Embed (auto-embedded on insert)
chunks = [
    {"text": "LanceDB supports hybrid search...", "source": "docs.md", "page": 1},
    {"text": "Vector indexes use IVF-PQ...", "source": "docs.md", "page": 2},
]
table.add(chunks)
table.create_fts_index("text")

# 3. Retrieve (hybrid search + rerank)
query = "how does hybrid search work?"
results = table.search(query, query_type="hybrid")
    .limit(5)
    .to_list()

# 4. Build context
context = "\n\n".join([r["text"] for r in results])

# 5. Send to LLM
prompt = f"Based on this context:\n{context}\n\nAnswer: {query}"
```

---

## Agent Memory with LanceDB

### How OpenClaw Uses It (memory-lancedb-pro Plugin)

**Schema:**
```typescript
{
  id: string,           // UUID
  text: string,         // FTS indexed
  vector: float[],      // Embedding vector
  category: string,     // "profile" | "preferences" | "entities" | "events" | "cases" | "patterns"
  scope: string,        // "global" | "agent:<id>" | "project:<id>" | "user:<id>"
  importance: float,    // 0-1 weight
  timestamp: number,    // Unix ms
  metadata: {
    l0_abstract: string,   // One-line summary
    l1_overview: string,   // Paragraph context
    l2_content: string,    // Full detail
    tier: string,          // "core" | "working" | "peripheral"
    access_count: number   // Reinforcement counter
  }
}
```

### 7-Layer Retrieval Pipeline

1. **Vector search** (ANN cosine) + **BM25 full-text** → fused (70/30 default)
2. **Cross-encoder reranking** (Jina Reranker v3) → blends 60% cross-encoder + 40% fused
3. **Recency boost** — exponential decay, half-life 14 days
4. **Importance weighting** — 0-1 multiplier on stored memories
5. **Length normalization** — prevents long entries dominating
6. **Time decay** — Weibull model, half-life 60 days, 0.5× floor (nothing fully disappears)
7. **Noise filter + MMR diversity** — removes near-duplicates, minimum score 0.35

### Memory Lifecycle

- **Auto-capture**: Extracts preferences/facts at session end via `agent_end` hook
- **Auto-recall**: Injects top-3 memories before agent reply via `before_agent_start` hook
- **Tier promotion**: Peripheral → Working → Core based on access frequency
- **Decay**: Weibull model — memories fade unless accessed
- **Deduplication**: Two-stage (embedding similarity + text overlap)
- **6 categories**: profile, preferences, entities, events, cases, patterns

### Basic Agent Memory Implementation (TypeScript)

```typescript
import * as lancedb from "@lancedb/lancedb";

const db = await lancedb.connect("~/.agent/memories");

// Create memories table
const table = await db.createTable("memories", [
  {
    id: "1",
    text: "User prefers tabs for indentation",
    vector: await embed("User prefers tabs for indentation"),
    category: "preference",
    scope: "global",
    importance: 0.9,
    timestamp: Date.now(),
  },
]);

// Create indexes
await table.createIndex("text", { config: lancedb.Index.fts() });
await table.createIndex("vector", { config: lancedb.Index.ivfPq() });

// Recall memories
const queryVector = await embed("coding style preferences");
const memories = await table
  .search(queryVector)
  .where("scope = 'global'")
  .limit(3)
  .toArray();

// Inject into agent context
const memoryContext = memories
  .map((m) => `[${m.category}] ${m.text}`)
  .join("\n");
```

---

## LanceDB MCP Servers

Three MCP servers available for agent ↔ LanceDB interaction:

| Server | Language | Tools | Use Case |
|--------|----------|-------|----------|
| **mcp-server-lancedb** (kyryl-opens-ml) | Python | `add-memory`, `search-memories` | Simple semantic memory |
| **lance-mcp** (adiom-data) | TypeScript | `catalog_search`, `chunks_search` | Document catalog + chunks |
| **lancedb-mcp-server** (official) | TypeScript | Native table ops | Full LanceDB access via MCP |

---

## Multi-Modal Search

```python
from lancedb.embeddings import get_registry

# CLIP for image+text search
clip = get_registry().get("open-clip").create()

class Image(LanceModel):
    image_uri: str = clip.SourceField()
    vector: Vector(512) = clip.VectorField()
    label: str

# Search images by text
results = table.search("a dog playing fetch").limit(5).to_list()

# Search images by image
results = table.search(clip.compute_query_embedding("path/to/image.jpg")).limit(5).to_list()
```

---

## Production Patterns

### Concurrent Access
- **Reads**: Thread-safe, concurrent OK
- **Writes**: Sequential (lock-based). One writer at a time.
- **Multi-process**: Reads OK. Writes need external coordination.

### Backup
```python
import shutil
shutil.copytree("./my-db", "./my-db-backup")
```

### Performance Tuning Checklist
- [ ] Index created after initial bulk load (not during)
- [ ] `nprobes` tuned for recall/speed trade-off (10=fast, 50=accurate)
- [ ] Scalar indexes on frequently filtered columns
- [ ] FTS index on text columns used in hybrid search
- [ ] Compact files periodically (reduces fragment count)
- [ ] Cleanup old versions (frees storage)

---

## Deployment & Pricing

| Tier | Cost | Storage | Use Case |
|------|------|---------|----------|
| **OSS** | Free | Local / S3 / GCS / Azure | Dev, edge, self-hosted |
| **Cloud** | $0.025/1M queries, $0.10/1M writes, $0.33/GB/mo | AWS managed | Production SaaS |
| **Enterprise** | Custom ($5K-$50K+/yr) | On-premises | Compliance, data residency |

Cloud free tier: 1M writes, 1M queries, 10GB storage.

---

## vs. Alternatives

| Feature | LanceDB | Pinecone | Chroma | pgvector |
|---------|---------|----------|--------|----------|
| **Deployment** | Embedded + cloud | Cloud only | Embedded + cloud | Requires Postgres |
| **Hybrid search** | Vector + BM25 + SQL | Vector only | Vector + metadata | Vector + SQL |
| **Versioning** | Native (time-travel) | ❌ | ❌ | ❌ |
| **Multimodal** | Native | ❌ | ❌ | ❌ |
| **Cost** | Free (OSS) | $70+/mo | Free (OSS) | Free (in Postgres) |
| **Format** | Lance (columnar) | Proprietary | DuckDB | Postgres heap |
| **Random access** | 100x Parquet | N/A | Standard | Standard |

---

## Key Insight

LanceDB's value proposition for agent memory is **zero operational overhead**. No database server to run, no connection strings, no auth. Just `import lancedb` and `connect("./memories")`. Data lives as files on disk. Embeddings auto-compute on insert. Hybrid search works out of the box. That's why OpenClaw chose it — memory should feel native, not bolted on.

---

## Sources

- [LanceDB Official Docs](https://docs.lancedb.com)
- [GitHub: lancedb/lancedb](https://github.com/lancedb/lancedb) (9,612 ⭐)
- [GitHub: lance-format/lance](https://github.com/lance-format/lance) (6,192 ⭐)
- [LanceDB Blog: Why LanceDB Is the Most Natural Memory Layer](https://lancedb.com/blog/openclaw-lancedb-memory-layer/)
- [GitHub: CortexReach/memory-lancedb-pro](https://github.com/CortexReach/memory-lancedb-pro) (3,366 ⭐)
- [Dev.to: Build a LanceDB Memory Plugin](https://dev.to/chwu1946/build-a-lancedb-memory-plugin-for-openclaw-102h)
- [LanceDB Pricing](https://lancedb.com/pricing)
- [VectorDB Recipes](https://github.com/lancedb/vectordb-recipes) — 40+ examples
- [TypeScript SDK](https://www.npmjs.com/package/@lancedb/lancedb) (v0.27.0)
- [Python SDK](https://pypi.org/project/lancedb/) (v0.30.1)
