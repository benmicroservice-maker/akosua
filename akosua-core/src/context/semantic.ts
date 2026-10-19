import { promises as fs } from "node:fs";
import { createHash } from "node:crypto";
import { bm25Scores, rrfFuse, importAdjacency } from "./retrieval.js";
import path from "node:path";
import { indexProject, type ProjectIndex } from "./indexer.js";
import type { Tool } from "../agent/tools.js";

/** Semantic layer: chunk -> vector -> cosine search. The Embedder is an
 * interface on purpose: HashEmbedder (local, deterministic, zero keys) is
 * the offline default; an OpenAI/Claude embeddings adapter can be dropped
 * in later without touching search or tools. */
export interface Embedder { readonly id: string; embed(texts: string[]): Promise<number[][]>; }

const DIM = 256;
export class HashEmbedder implements Embedder {
  readonly id = "hash-local";
  async embed(texts: string[]) {
    return texts.map(t => {
      const v = new Array(DIM).fill(0);
      for (const tok of tokenize(t)) {
        let h = 2166136261; for (let i = 0; i < tok.length; i++) { h ^= tok.charCodeAt(i); h = Math.imul(h, 16777619); }
        v[Math.abs(h) % DIM] += 1;
      }
      const n = Math.hypot(...v) || 1; return v.map(x => x / n);
    });
  }
}
const cosine = (a: number[], b: number[]) => a.reduce((s, x, i) => s + x * b[i], 0);

/** Tokenize for the local embedder: splits snake_case, kebab-case and
 * camelCase/PascalCase compound identifiers (OrdersScreen -> orders+screen,
 * ConsumerWidget -> consumer+widget, flutter_riverpod -> flutter+riverpod),
 * keeping the compound form too. Code meaning lives in identifiers. */
export function tokenize(text: string): string[] {
  const out: string[] = [];
  for (const raw of text.split(/[^A-Za-z0-9]+/)) {
    if (!raw) continue;
    out.push(raw.toLowerCase());
    for (const part of raw.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2").split(" "))
      if (part.length > 1) out.push(part.toLowerCase());
  }
  return out.filter(x => x.length > 1);
}

export interface Chunk { path: string; startLine: number; endLine?: number; text: string; symbol?: string; }
export interface SemanticIndex { chunks: Chunk[]; vectors: number[][]; }

/** Syntactic chunking (A4 — the Cursor lesson): split at SYMBOL boundaries,
 * never mid-function by line count. A lightweight structural splitter (no
 * tree-sitter dependency): brace-depth tracking for TS/JS/Dart, indentation
 * for Python. Sibling symbols merge up to ~2000 chars; oversized symbols fall
 * back to line windows INSIDE the symbol. Each chunk carries its symbol name
 * so retrieval can rank and cite precisely. */
const SYMBOL_START = [
  /^\s*(?:export\s+)?(?:default\s+)?(?:abstract\s+)?(?:class|interface|enum|type|function)\s+(\w+)/,
  /^\s*(?:export\s+)?(?:async\s+)?function\s+(\w+)/,
  /^\s*(?:public|private|protected|static|async|override|\w+)\s+(\w+)\s*\([^)]*\)\s*(?:async\s*)?[{:]/, // methods / Dart members (best effort)
  /^\s*(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s*)?\(/,
];
const PY_START = /^(?:async\s+def|def|class)\s+(\w+)/;

export function chunkText(rel: string, content: string, maxChars = 2000): Chunk[] {
  const lines = content.split("\n");
  const isPy = rel.endsWith(".py");
  // 1. find symbol start lines
  const starts: { line: number; name: string }[] = [];
  let depth = 0;
  lines.forEach((l, i) => {
    if (isPy) { const m = PY_START.exec(l); if (m) starts.push({ line: i, name: m[1] }); return; }
    if (depth === 0) for (const re of SYMBOL_START) { const m = re.exec(l); if (m) { starts.push({ line: i, name: m[1] }); break; } }
    for (const ch of l) { if (ch === "{") depth++; else if (ch === "}") depth = Math.max(0, depth - 1); }
  });
  if (!starts.length) { // no structure detected: line windows (previous behaviour)
    const out: Chunk[] = [];
    for (let i = 0; i < lines.length; i += 60) out.push({ path: rel, startLine: i + 1, endLine: Math.min(i + 60, lines.length), text: lines.slice(i, i + 60).join("\n") });
    return out;
  }
  // 2. symbol spans
  const spans = starts.map((s, i) => ({ name: s.name, from: s.line, to: (starts[i + 1]?.line ?? lines.length) }));
  if (spans[0].from > 0) spans.unshift({ name: "(preamble)", from: 0, to: spans[0].from });
  // 3. merge siblings to budget; split oversized
  const out: Chunk[] = [];
  let buf: string[] = [], bufStart = 0, bufSym = "";
  let bufEnd = 0;
  const flush = () => { if (buf.length) out.push({ path: rel, startLine: bufStart + 1, endLine: bufEnd, text: buf.join("\n"), symbol: bufSym || undefined }); buf = []; bufSym = ""; };
  for (const span of spans) {
    const text = lines.slice(span.from, span.to);
    if (text.join("\n").length > maxChars) {
      flush();
      for (let i = 0; i < text.length; i += 50) out.push({ path: rel, startLine: span.from + i + 1, endLine: span.from + Math.min(i + 50, text.length), text: text.slice(i, i + 50).join("\n"), symbol: span.name });
      continue;
    }
    if (buf.join("\n").length + text.join("\n").length > maxChars) flush();
    if (!buf.length) bufStart = span.from;
    bufEnd = span.to;
    bufSym = bufSym ? `${bufSym},${span.name}` : span.name;
    buf.push(...text);
  }
  flush();
  return out.filter(c => c.text.trim());
}

/** Embed chunk texts, reusing a content-hash cache (Cursor's trick):
 * identical chunk content — unchanged file, moved file, duplicate — is never
 * embedded twice. Cache is persisted alongside the index per embedder id. */
export const chunkEmbedText = (c: Chunk) => `${c.path} ${c.symbol ?? ""}\n${c.text}`;
export async function embedWithCache(embedder: Embedder, chunks: Chunk[], cache: Record<string, number[]>): Promise<number[][]> {
  const out: number[][] = new Array(chunks.length);
  const missIdx: number[] = []; const missTexts: string[] = [];
  const pending = new Map<string, number[]>(); // hash -> chunk indices waiting on this batch
  chunks.forEach((c, i) => {
    const h = createHash("sha256").update(chunkEmbedText(c)).digest("hex");
    if (cache[h]) { out[i] = cache[h]; return; }
    const waiters = pending.get(h);
    if (waiters) { waiters.push(i); return; } // duplicate WITHIN this batch: embed once
    pending.set(h, [i]); missIdx.push(i); missTexts.push(chunkEmbedText(c));
  });
  if (missTexts.length) {
    const fresh = await embedder.embed(missTexts);
    missIdx.forEach((ci, j) => {
      const h = createHash("sha256").update(chunkEmbedText(chunks[ci])).digest("hex");
      cache[h] = fresh[j];
      for (const waiter of pending.get(h)!) out[waiter] = fresh[j];
    });
  }
  return out;
}

export async function buildSemanticIndex(root: string, embedder: Embedder, idx?: ProjectIndex): Promise<SemanticIndex> {
  const project = idx ?? await indexProject(root);
  const chunks: Chunk[] = [];
  for (const f of project.files) {
    let content: string; try { content = await fs.readFile(path.join(root, f.path), "utf8"); } catch { continue; }
    chunks.push(...chunkText(f.path, content));
  }
  const vectors = await embedWithCache(embedder, chunks, {});
  return { chunks, vectors };
}

/** Optional LLM reranker: receives the fused top-N and returns them in
 * best-first order (subset allowed). This is the poor-man's trace-training:
 * a strong model judging "what would actually help" at query time. */
export interface Reranker { rerank(query: string, hits: { chunk: Chunk; score: number }[]): Promise<{ chunk: Chunk; score: number }[]>; }

export async function semanticSearch(index: SemanticIndex, embedder: Embedder, query: string, k = 6,
  opts?: { adjacency?: Map<string, Set<string>>; reranker?: Reranker; pool?: number }) {
  const [qv] = await embedder.embed([query]);
  const vec = index.chunks.map((c, i) => cosine(qv, index.vectors[i]));
  const bm = bm25Scores(query, index.chunks);
  const byVec = vec.map((_, i) => i).sort((a, b) => vec[b] - vec[a]);
  const byBm = bm.map((_, i) => i).sort((a, b) => bm[b] - bm[a]);
  const fused = rrfFuse([byVec, byBm]);
  const maxFused = Math.max(...fused.values(), 1e-9);
  let hits = index.chunks.map((c, i) => ({
    chunk: c,
    score: (fused.get(i) ?? 0) / maxFused * 0.7 + hybridScore(query, c, vec[i]) * 0.3,
  })).sort((a, b) => b.score - a.score);
  // Graph boost: neighbours of the top hits (callers/callees by import) rise.
  if (opts?.adjacency) {
    const topFiles = new Set(hits.slice(0, 3).map(h => h.chunk.path));
    const neighbours = new Set<string>();
    for (const f of topFiles) for (const n of opts.adjacency.get(f) ?? []) neighbours.add(n);
    hits = hits.map(h => neighbours.has(h.chunk.path) && !topFiles.has(h.chunk.path) ? { ...h, score: h.score * 1.12 } : h)
      .sort((a, b) => b.score - a.score);
  }
  const pool = hits.slice(0, opts?.pool ?? Math.max(k, 12));
  if (opts?.reranker && pool.length > 1) {
    try { return (await opts.reranker.rerank(query, pool)).slice(0, k); } catch { /* rerank is a bonus, never a blocker */ }
  }
  return pool.slice(0, k);
}

export const semanticSearchTool = (getIndex: () => Promise<SemanticIndex>, embedder: Embedder, getAdjacency?: () => Promise<Map<string, Set<string>> | undefined>): Tool => ({
  definition: { name: "semantic_search", description: "Search the codebase by MEANING (not exact text): 'where do we handle order creation?', 'the flutter screen showing orders'. Returns the most relevant code chunks with file+line. Use search_code instead when you know the exact symbol/text and need proof.",
    parameters: { type: "object", required: ["query"], properties: { query: { type: "string" } } } },
  phases: ["understand", "plan", "build"],
  async run(a) {
    const hits = await semanticSearch(await getIndex(), embedder, String(a.query), 6, { adjacency: getAdjacency ? await getAdjacency().catch(() => undefined) : undefined });
    return hits.map(h => `--- ${h.chunk.path}:${h.chunk.startLine}${h.chunk.symbol ? ` [${h.chunk.symbol}]` : ""} (score ${h.score.toFixed(3)}) ---\n${h.chunk.text.slice(0, 900)}`).join("\n\n") || "No semantic matches.";
  },
});

/** Persisted + incremental semantic index (Merkle-lite): the index lives in
 * .akosua/semantic-index.json with a per-file {mtime,size} manifest. Refresh
 * re-chunks ONLY files whose manifest entry changed and drops deleted ones —
 * unchanged files keep their chunks/vectors untouched. */
export interface IndexManifest { embedder: string; files: Record<string, { m: number; s: number }>; }
const SEM_FILE = path.join(".akosua", "semantic-index.json");

export async function refreshSemanticIndex(root: string, embedder: Embedder): Promise<SemanticIndex> {
  const idx = await indexProject(root);
  const files: Record<string, { m: number; s: number }> = {};
  for (const f of idx.files) {
    const st = await fs.stat(path.join(root, f.path)).catch(() => undefined);
    if (st) files[f.path] = { m: Math.floor(st.mtimeMs), s: st.size };
  }
  let prev: { manifest: IndexManifest; index: SemanticIndex; cache?: Record<string, number[]> } | undefined;
  try {
    const raw = JSON.parse(await fs.readFile(path.join(root, SEM_FILE), "utf8"));
    if (raw?.manifest?.embedder === embedder.id && raw?.index?.chunks) prev = raw;
  } catch { /* cold start */ }
  if (!prev) {
    const index = await buildSemanticIndex(root, embedder, idx);
    await saveSemanticIndex(root, { embedder: embedder.id, files }, index).catch(() => undefined);
    return index;
  }
  const changed = Object.keys(files).filter(pth => {
    const a = prev!.manifest.files[pth], b = files[pth];
    return !a || a.m !== b.m || a.s !== b.s;
  });
  const keepPaths = new Set(Object.keys(files).filter(pth => !changed.includes(pth)));
  const keptChunks: Chunk[] = []; const keptVectors: number[][] = [];
  prev.index.chunks.forEach((c, i) => { if (keepPaths.has(c.path)) { keptChunks.push(c); keptVectors.push(prev!.index.vectors[i]); } });
  const newChunks: Chunk[] = [];
  for (const pth of changed) {
    const content = await fs.readFile(path.join(root, pth), "utf8").catch(() => "");
    if (content) newChunks.push(...chunkText(pth, content));
  }
  const cache: Record<string, number[]> = prev.cache ?? {};
  const newVectors = newChunks.length ? await embedWithCache(embedder, newChunks, cache) : [];
  const index: SemanticIndex = { chunks: [...keptChunks, ...newChunks], vectors: [...keptVectors, ...newVectors] };
  await saveSemanticIndex(root, { embedder: embedder.id, files }, index, cache).catch(() => undefined);
  return index;
}
async function saveSemanticIndex(root: string, manifest: IndexManifest, index: SemanticIndex, cache?: Record<string, number[]>): Promise<void> {
  const abs = path.join(root, SEM_FILE);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, JSON.stringify({ manifest, index, cache: cache ?? {} }), "utf8");
}

/** Neural embeddings via the user's own OpenAI key (text-embedding-3-small).
 * Batched; any failure throws so the caller can fall back to HashEmbedder —
 * retrieval must degrade, never die. Fetch is injectable for tests. */
export class OpenAIEmbedder implements Embedder {
  readonly id = "openai:text-embedding-3-small";
  constructor(private getKey: () => Promise<string | undefined>, private fetchFn: typeof fetch = fetch) {}
  async embed(texts: string[]): Promise<number[][]> {
    const key = await this.getKey();
    if (!key) throw new Error("no OpenAI key");
    const out: number[][] = [];
    for (let i = 0; i < texts.length; i += 64) {
      const batch = texts.slice(i, i + 64);
      const res = await this.fetchFn("https://api.openai.com/v1/embeddings", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
        body: JSON.stringify({ model: "text-embedding-3-small", input: batch }),
      });
      if (!res.ok) throw new Error(`embeddings ${res.status}`);
      const data = await res.json() as { data: { embedding: number[] }[] };
      out.push(...data.data.map(d => d.embedding));
    }
    return out;
  }
}

/** Voyage code embeddings (voyage-code-4: purpose-built for coding-agent
 * retrieval). Same Embedder contract; failures throw so callers fall back. */
export class VoyageEmbedder implements Embedder {
  readonly id: string;
  constructor(private getKey: () => Promise<string | undefined>, private model = "voyage-code-4", private fetchFn: typeof fetch = fetch) { this.id = `voyage:${model}`; }
  async embed(texts: string[]): Promise<number[][]> {
    const key = await this.getKey();
    if (!key) throw new Error("no Voyage key");
    const out: number[][] = [];
    for (let i = 0; i < texts.length; i += 64) {
      const res = await this.fetchFn("https://api.voyageai.com/v1/embeddings", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
        body: JSON.stringify({ model: this.model, input: texts.slice(i, i + 64), input_type: "document" }),
      });
      if (!res.ok) throw new Error(`voyage embeddings ${res.status}`);
      const data = await res.json() as { data: { embedding: number[] }[] };
      out.push(...data.data.map(d => d.embedding));
    }
    return out;
  }
}

/** Hybrid ranking: vector cosine + lexical token overlap + identifier boost.
 * Pure-vector ranking misses exact-symbol queries; pure-lexical misses meaning.
 * Cursor reranks — this is our deterministic reranker (no extra model call). */
export function hybridScore(query: string, chunk: Chunk, vectorScore: number): number {
  const q = new Set(tokenize(query));
  if (!q.size) return vectorScore;
  const c = new Set(tokenize(chunk.text));
  let overlap = 0; for (const t of q) if (c.has(t)) overlap++;
  const lexical = overlap / q.size;
  const symbolBoost = chunk.symbol && [...q].some(t => chunk.symbol!.toLowerCase().includes(t)) ? 0.15 : 0;
  const pathBoost = [...q].some(t => chunk.path.toLowerCase().includes(t)) ? 0.05 : 0;
  return vectorScore * 0.65 + lexical * 0.35 + symbolBoost + pathBoost;
}
