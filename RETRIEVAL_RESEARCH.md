# Akosua Codebase Retrieval — Deep Research Report

**Question:** Cursor's retrieval edge was described as "trace-trained embeddings, Merkle-tree
incremental sync, tree-sitter chunking at massive scale, tuned on billions of real edits."
Can Akosua also get this?

**Verdict up front:** Yes to almost all of it — and one part of it we should *not* copy,
because Cursor itself has abandoned it. Details and evidence below. Researched 2026-10-18.

---

## 1. What Cursor actually built (public facts)

Cursor's own engineering blog describes the classic pipeline [1](https://cursor.com/blog/secure-codebase-indexing):

1. **Merkle-tree sync.** Every file gets a cryptographic (SHA-256) hash; folders hash their
   children up to one root hash. Client/server compare trees and only walk branches that
   diverge, so a 50,000-file workspace syncs by moving only changed files instead of ~3.2 MB
   of filenames+hashes every time [1](https://cursor.com/blog/secure-codebase-indexing).
2. **Syntactic chunking.** Changed files are split into *syntactic chunks* (AST-aligned units,
   ~500 tokens in third-party analyses [5](https://stg.bito.ai/blog/how-cursors-codebase-indexing-works-2026-guide/)),
   embedded, and embeddings are **cached by chunk content hash** — unchanged chunks are never
   re-embedded [1](https://cursor.com/blog/secure-codebase-indexing).
3. **Custom embedding model.** Chunks are embedded by Cursor's own model and stored in
   Turbopuffer (a vector DB) with only an *obfuscated path + line range* as metadata — raw
   code never persists server-side; the client reads actual chunks locally at query time
   [1](https://cursor.com/blog/secure-codebase-indexing).
4. **Index reuse via simhash.** A new user's codebase gets a similarity hash; if a teammate's
   index is similar enough, it is copied as the starting index (copies of the same codebase
   are ~92% identical in practice) and reconciled in the background
   [1](https://cursor.com/blog/secure-codebase-indexing) [10](https://the-decoder.com/cursor-slashes-codebase-indexing-from-four-hours-to-21-seconds).
5. **Dual index.** Alongside the semantic index, a local **trigram/sparse n-gram index**
   powered regex/grep-style search, kept perfectly fresh against the current git state,
   because a stale regex index makes the agent hunt for code it just wrote
   [4](https://x.com/manthanguptaa/article/2067096080886698364).

### The "trace-trained embeddings" part

Third-party reverse-engineering describes the training signal precisely: agent sessions are
the training data — an agent searches, opens files, and eventually finds the right code; an
LLM retroactively ranks what *would have been most helpful* at each step, and the embedding
model is trained (contrastive-style) to align its similarity scores with those rankings. The
model therefore optimises for "which chunk actually helps the agent on this task" rather than
"which chunks look alike" [4](https://x.com/manthanguptaa/article/2067096080886698364).
Cursor's own evaluation put semantic search at **~12.5% better agent accuracy** than grep
alone on large codebases [11](https://dev.to/danielwe/you-can-index-every-repo-in-cursor-it-still-cant-tell-you-what-breaks-4j5i).

## 2. The plot twist: Cursor has *removed* semantic indexing

This is the most important finding of this research, and it changes what we should build.

- Cursor staff (Kevin M., Maxime P., Dean R. Jul–Sep 2026): *"models have gotten really
  good at using grep / indexed search, so the older dedicated semantic search path was
  rapidly no longer helping"*; Cursor *"no longer builds a semantic index of your codebase
  and doesn't compute or store embeddings on servers"* — search is now **Instant Grep**
  (a custom local indexed-grep engine) plus normal file reads
  [2](https://forum.cursor.com/t/what-do-you-think-about-cursor-removing-the-codebase-indexing-settings/165899/5)
  [3](https://forum.cursor.com/t/how-to-reindexing-my-codebase/170407/6).
- Cursor's current docs confirm: Instant Grep "outperforms ripgrep on large codebases",
  builds and queries its index **on your machine**, and "Cursor does not … store embeddings
  of your codebase for search" [5](https://cursor.com/docs/agent/tools/search).
- Reported internal numbers: regex search latency cut from 16.8 s (ripgrep) to ~13 ms on
  large monorepos via the indexed approach [12](https://analyticsindiamag.com/ai-news/cursor-delivers-99-faster-ai-code-search-with-instant-grep).

**Implication:** the "massive-scale embedding index" we envied was, at Cursor's own
evaluation in 2026, no longer worth its cost *for their agent* — because frontier models
learned to drive grep well. Chasing an exact replica of 2025-Cursor would be building
yesterday's architecture. The correct target is the **end state both eras point to**:
a *hybrid* — instant local lexical index (fresh, exact) + semantic retrieval where it
still wins (conceptual queries, cross-vocabulary, huge repos) — fused, not either/or.

Note the honest tension: Cursor's own Jan-2026 number said semantic added ~12.5% accuracy
[11](https://dev.to/danielwe/you-can-index-every-repo-in-cursor-it-still-cant-tell-you-what-breaks-4j5i),
and independent practitioners report hybrid BM25+vector fusion beating either alone by
large margins (e.g. +48% accuracy over dense-only in one open-source implementation
[2](https://github.com/us/qex)). Embeddings aren't dead; they're a component, not the product.

## 3. Component-by-component: can Akosua get each piece?

| Cursor component | Replicable? | How Akosua gets it |
|---|---|---|
| Merkle-tree incremental sync | **Yes, fully** | Akosua's indexer *already* sha256-hashes every file and skips unchanged ones (`akosua-core/src/context/indexer.ts`). Upgrading flat hashes to a directory Merkle tree + chunk-hash embedding cache is a small, well-understood step. |
| Tree-sitter syntactic chunking (~500 tok) | **Yes, fully** | `web-tree-sitter` (WASM, no native build — critical for our VS Code fork) or tree-sitter grammars for TS/JS, Dart, Python. Akosua today uses regex-based `chunkText` with a 2,000-char cap (`semantic.ts`) — the single biggest quality gap, and the cheapest to close. |
| Vector storage at scale | **Yes, right-sized** | Turbopuffer is for trillions of vectors / 80M namespaces. A personal IDE needs one codebase at a time: **SQLite + sqlite-vec + FTS5** (one local file, BM25 and vectors side by side) or LanceDB. sqlite-vec does exact KNN by brute-force scan — perfectly fine at personal-repo scale (≤ ~1M chunks) [4](https://www.mongreldb.com/embedded-database-vector-search/) [1](https://infino.ai/blog/embedded-full-text-and-vector-search/). |
| Custom production embedding model | **Mostly, via API** | Off-the-shelf code embedders are now strong: Voyage's `voyage-code-4` is purpose-built for coding-agent retrieval and reports +28% over Cohere Embed v4 on agent-retrieval benchmarks (vendor numbers, not independently verified) [13](https://blog.voyageai.com/2026/08/13/voyage-code-4/); OpenAI `text-embedding-3-small/large` are cheap baselines ($0.02/$0.13 per 1M tokens [2](https://openrouter.ai/blog/insights/best-embedding-models-2026/)); open-weight options (Qwen3-Embedding, nomic-embed-code) run locally via ONNX for zero-cost/private indexing. One independent benchmark warns a fine-tuned 0.6B model beat every stock 8B on in-domain data — and BM25 beats most neural embedders on SWE-bench retrieval [5](https://theairankings.com/best-embedding-models/). |
| **Trace-trained embeddings** (trained on billions of agent edits) | **No — not the data, yes the technique (small-scale)** | The moat is Cursor's corpus of real agent traces across millions of users; nobody can buy that. But the *method* is replicable at personal scale: Akosua already persists run artifacts. Logging (query → chunks retrieved → chunks actually used/edited) creates trace data to (a) rerank with an LLM at query time (top-50 → top-10, no training needed), and (b) later fine-tune a small open embedder on *your* stacks/repos. This is a v2 moat, not a v1 blocker. |
| Instant Grep (local trigram index, ms regex) | **Yes** | Classic trigram inverted index (Zobel/Moffat 1993; Russ Cox's codesearch design). Proven open implementations exist (Rust/Tantivy-based hybrid engines with tree-sitter + Merkle incremental indexing ship as single binaries [1](https://github.com/ryanmcafee/codesearch) [2](https://github.com/us/qex)). Akosua's `search_code` is plain scan today; a trigram pre-filter + regex confirm gets us the same asymptotics. |
| Simhash index-reuse across teammates | **Unnecessary** | Personal, single-user IDE. Skip entirely — one less cloud system. |

## 4. What Akosua has today (codebase truth, not memory)

- `src/context/indexer.ts` — structural index with **sha256 incremental re-indexing** (Merkle-equivalent
  change detection at file level), symbol/import extraction, contract map. ✅ foundation exists.
- `src/context/semantic.ts` — `HashEmbedder` (camelCase-aware local hash embeddings, zero-cost,
  zero-quality-ceiling), regex `chunkText` (2,000 chars), an `OpenAIEmbedder` adapter, and a
  `hybridScore` lexical+vector blend. Interface (`Embedder`) is already pluggable. ⚠️ chunking
  and default embedder are the weak links.
- No trigram/BM25 index, no vector store persistence, no reranker. Search tools today:
  `search_code`, `list_files`, `semantic_search`, plus Project Brain/contract graph.

## 5. Recommended build: Akosua Retrieval v2 (local-first hybrid)

1. **R1 — Tree-sitter chunking (highest value per effort).** Replace regex `chunkText` with
   web-tree-sitter WASM chunking (function/class/method boundaries, ≤ ~500 tokens, signature +
   docstring header per chunk) for TS/JS/Dart/Python; keep regex fallback. Directly upgrades
   both the Brain and semantic search.
2. **R2 — Real embeddings behind the existing `Embedder` interface.** Default: OpenAI
   `text-embedding-3-small` (already have the provider plumbing + keys UX) or Voyage
   `voyage-code-4` via a new provider slot; optional local `nomic-embed-code` (ONNX) for
   offline/private. Persist vectors + FTS5 in **one SQLite file** under `.akosua/`; cache
   embeddings by chunk content hash (Cursor's trick — re-index becomes near-free).
3. **R3 — Trigram "Instant Search".** Local trigram inverted index (seeded from git HEAD,
   layered with working-tree edits, `.gitignore`-aware) pre-filtering regex search. This is
   the piece Cursor *kept* — freshness here prevents the agent hunting for its own edits.
4. **R4 — Fusion + rerank.** BM25(FTS5) + vector + trigram candidates fused with Reciprocal
   Rank Fusion; contract-map/graph proximity boost (callers/callees of top hits); optional
   LLM rerank of top-50 → top-10 using the Planner model. This is where harness craft beats
   raw embedder quality.
5. **R5 (later, the moat).** Trace logging from real Akosua runs → evaluate LLM-rerank gains;
   if retrieval still misses, fine-tune a small open embedder on your own traces/stacks.

**Cost sketch (personal scale):** embedding a large personal monorepo (~20M tokens of chunks,
once; incremental thereafter) ≈ $0.40 (OpenAI small) to ~$2.40 (Voyage code) — or $0 locally.
Storage: ~3 GB per 1M float32 chunks worst case, ~190 MB binary-quantised [2](https://www.llms.blog/posts/embedded-vector-databases-in-production-comparing-lancedb-sqlite-vec-duckdb-vss-and-chroma);
real personal repos are far below that.

## 6. Honest bottom line

- We can build **~85–90% of the practical retrieval quality** of classic Cursor with
  commodity parts, locally, at near-zero running cost. The architecture is public, the
  components are open, and Akosua's foundation (hash-incremental indexer, pluggable
  Embedder, contract graph) is already pointed the right way.
- We **cannot** replicate trace-training on billions of edits — that dataset is Cursor's
  moat, not their algorithm. Our counter is stack specialisation + graph/harness fusion +
  (eventually) traces from your own usage.
- And the field has moved: Cursor deleted the embedding index in favour of Instant Grep in
  2026 [2](https://forum.cursor.com/t/what-do-you-think-about-cursor-removing-the-codebase-indexing-settings/165899/5).
  The winning design is **hybrid**: instant local lexical search as the spine, semantic
  retrieval as recall insurance, fused and reranked. That's Retrieval v2 above — and it's
  a better target than a museum copy of 2025 Cursor.

*Sources: Cursor engineering blog & docs, Cursor staff forum posts (Jul–Sep 2026), Voyage AI,
OpenRouter/benchmark roundups, embedded-DB comparisons, open-source hybrid search engines.
Vendor benchmark numbers are labelled as such where they appear; Akosua-side claims were
verified against `akosua-core/src/context/` on 2026-10-18.*
