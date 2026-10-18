import { promises as fs } from "node:fs";
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

export interface Chunk { path: string; startLine: number; text: string; symbol?: string; }
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
    for (let i = 0; i < lines.length; i += 60) out.push({ path: rel, startLine: i + 1, text: lines.slice(i, i + 60).join("\n") });
    return out;
  }
  // 2. symbol spans
  const spans = starts.map((s, i) => ({ name: s.name, from: s.line, to: (starts[i + 1]?.line ?? lines.length) }));
  if (spans[0].from > 0) spans.unshift({ name: "(preamble)", from: 0, to: spans[0].from });
  // 3. merge siblings to budget; split oversized
  const out: Chunk[] = [];
  let buf: string[] = [], bufStart = 0, bufSym = "";
  const flush = () => { if (buf.length) out.push({ path: rel, startLine: bufStart + 1, text: buf.join("\n"), symbol: bufSym || undefined }); buf = []; bufSym = ""; };
  for (const span of spans) {
    const text = lines.slice(span.from, span.to);
    if (text.join("\n").length > maxChars) {
      flush();
      for (let i = 0; i < text.length; i += 50) out.push({ path: rel, startLine: span.from + i + 1, text: text.slice(i, i + 50).join("\n"), symbol: span.name });
      continue;
    }
    if (buf.join("\n").length + text.join("\n").length > maxChars) flush();
    if (!buf.length) bufStart = span.from;
    bufSym = bufSym ? `${bufSym},${span.name}` : span.name;
    buf.push(...text);
  }
  flush();
  return out.filter(c => c.text.trim());
}

export async function buildSemanticIndex(root: string, embedder: Embedder, idx?: ProjectIndex): Promise<SemanticIndex> {
  const project = idx ?? await indexProject(root);
  const chunks: Chunk[] = [];
  for (const f of project.files) {
    let content: string; try { content = await fs.readFile(path.join(root, f.path), "utf8"); } catch { continue; }
    chunks.push(...chunkText(f.path, content));
  }
  const vectors = await embedder.embed(chunks.map(c => `${c.path} ${c.symbol ?? ""}\n${c.text}`));
  return { chunks, vectors };
}

export async function semanticSearch(index: SemanticIndex, embedder: Embedder, query: string, k = 6) {
  const [qv] = await embedder.embed([query]);
  return index.chunks.map((c, i) => ({ chunk: c, score: hybridScore(query, c, cosine(qv, index.vectors[i])) }))
    .sort((a, b) => b.score - a.score).slice(0, k);
}

export const semanticSearchTool = (getIndex: () => Promise<SemanticIndex>, embedder: Embedder): Tool => ({
  definition: { name: "semantic_search", description: "Search the codebase by MEANING (not exact text): 'where do we handle order creation?', 'the flutter screen showing orders'. Returns the most relevant code chunks with file+line. Use search_code instead when you know the exact symbol/text and need proof.",
    parameters: { type: "object", required: ["query"], properties: { query: { type: "string" } } } },
  phases: ["understand", "plan", "build"],
  async run(a) {
    const hits = await semanticSearch(await getIndex(), embedder, String(a.query));
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
  let prev: { manifest: IndexManifest; index: SemanticIndex } | undefined;
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
  const newVectors = newChunks.length ? await embedder.embed(newChunks.map(c => `${c.path} ${c.symbol ?? ""}\n${c.text}`)) : [];
  const index: SemanticIndex = { chunks: [...keptChunks, ...newChunks], vectors: [...keptVectors, ...newVectors] };
  await saveSemanticIndex(root, { embedder: embedder.id, files }, index).catch(() => undefined);
  return index;
}
async function saveSemanticIndex(root: string, manifest: IndexManifest, index: SemanticIndex): Promise<void> {
  const abs = path.join(root, SEM_FILE);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, JSON.stringify({ manifest, index }), "utf8");
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
