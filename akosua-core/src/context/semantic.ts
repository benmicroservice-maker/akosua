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

export interface Chunk { path: string; startLine: number; text: string; }
export interface SemanticIndex { chunks: Chunk[]; vectors: number[][]; }

export function chunkText(rel: string, content: string, maxLines = 60): Chunk[] {
  const lines = content.split("\n"); const out: Chunk[] = [];
  for (let i = 0; i < lines.length; i += maxLines)
    out.push({ path: rel, startLine: i + 1, text: lines.slice(i, i + maxLines).join("\n") });
  return out;
}

export async function buildSemanticIndex(root: string, embedder: Embedder, idx?: ProjectIndex): Promise<SemanticIndex> {
  const project = idx ?? await indexProject(root);
  const chunks: Chunk[] = [];
  for (const f of project.files) {
    let content: string; try { content = await fs.readFile(path.join(root, f.path), "utf8"); } catch { continue; }
    chunks.push(...chunkText(f.path, content));
  }
  const vectors = await embedder.embed(chunks.map(c => `${c.path}\n${c.text}`));
  return { chunks, vectors };
}

export async function semanticSearch(index: SemanticIndex, embedder: Embedder, query: string, k = 6) {
  const [qv] = await embedder.embed([query]);
  return index.chunks.map((c, i) => ({ chunk: c, score: cosine(qv, index.vectors[i]) }))
    .sort((a, b) => b.score - a.score).slice(0, k);
}

export const semanticSearchTool = (getIndex: () => Promise<SemanticIndex>, embedder: Embedder): Tool => ({
  definition: { name: "semantic_search", description: "Search the codebase by MEANING (not exact text): 'where do we handle order creation?', 'the flutter screen showing orders'. Returns the most relevant code chunks with file+line. Use search_code instead when you know the exact symbol/text and need proof.",
    parameters: { type: "object", required: ["query"], properties: { query: { type: "string" } } } },
  phases: ["understand", "plan", "build"],
  async run(a) {
    const hits = await semanticSearch(await getIndex(), embedder, String(a.query));
    return hits.map(h => `--- ${h.chunk.path}:${h.chunk.startLine} (score ${h.score.toFixed(3)}) ---\n${h.chunk.text.slice(0, 900)}`).join("\n\n") || "No semantic matches.";
  },
});
