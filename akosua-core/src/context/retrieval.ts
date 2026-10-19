import { promises as fs } from "node:fs";
import path from "node:path";
import { walk } from "./indexer.js";
import { tokenize, type Chunk } from "./semantic.js";

/** Retrieval v2 primitives (RETRIEVAL_RESEARCH.md R3/R4):
 *  - TrigramIndex: local inverted index over 3-char grams — the "Instant
 *    Grep" idea Cursor kept after dropping embeddings. Pre-filters candidate
 *    files for a literal/regex query so confirmation scans touch a handful
 *    of files, and it is rebuilt from the working tree so it is ALWAYS fresh
 *    (never misses code the agent just wrote).
 *  - BM25: lexical ranking that beats most neural embedders on exact-
 *    identifier retrieval; fused with vector ranking via RRF.
 *  - graphBoost: chunks in files import-adjacent to top hits rank higher —
 *    code that calls/is-called-by the answer is usually part of the answer. */

export function trigrams(text: string): Set<string> {
  const out = new Set<string>();
  const t = text.toLowerCase();
  for (let i = 0; i + 3 <= t.length; i++) out.add(t.slice(i, i + 3));
  return out;
}

/** Literal strings extractable from a query/regex source: the longest runs
 * of plain characters are decomposed into trigrams for candidate filtering. */
export function queryTrigrams(query: string): Set<string> | undefined {
  const runs = query.toLowerCase().split(/[^a-z0-9_./-]+/).filter(r => r.length >= 3);
  if (!runs.length) return undefined; // too short/symbolic: cannot pre-filter
  const grams = new Set<string>();
  for (const r of runs) for (const g of trigrams(r)) grams.add(g);
  return grams.size ? grams : undefined;
}

export class TrigramIndex {
  private postings = new Map<string, Set<string>>();
  private constructor(private contents: Map<string, string>) {}
  static build(contents: Map<string, string>): TrigramIndex {
    const idx = new TrigramIndex(contents);
    for (const [file, content] of contents) for (const g of trigrams(content)) {
      let s = idx.postings.get(g); if (!s) idx.postings.set(g, s = new Set());
      s.add(file);
    }
    return idx;
  }
  static async fromWorkspace(root: string): Promise<TrigramIndex> {
    const contents = new Map<string, string>();
    for await (const abs of walk(root)) {
      try { contents.set(path.relative(root, abs), await fs.readFile(abs, "utf8")); } catch { /* unreadable: skip */ }
    }
    return TrigramIndex.build(contents);
  }
  /** Files that can possibly match (superset; caller confirms by scanning). */
  candidates(query: string): string[] | undefined {
    const grams = queryTrigrams(query);
    if (!grams) return undefined;
    let acc: Set<string> | undefined;
    for (const g of grams) {
      const s = this.postings.get(g);
      if (!s) return [];
      acc = acc ? new Set([...acc].filter(f => s.has(f))) : new Set(s);
      if (!acc.size) return [];
    }
    return [...(acc ?? [])];
  }
  content(file: string): string | undefined { return this.contents.get(file); }
  files(): string[] { return [...this.contents.keys()]; }
}

/** BM25 over chunk texts. k1/b standard; idf smoothed. Returns raw scores. */
export function bm25Scores(query: string, chunks: Chunk[]): number[] {
  const q = [...new Set(tokenize(query))];
  const docs = chunks.map(c => tokenize(`${c.path} ${c.symbol ?? ""} ${c.text}`));
  const N = docs.length || 1;
  const avgLen = docs.reduce((s, d) => s + d.length, 0) / N || 1;
  const df = new Map<string, number>();
  for (const d of docs) for (const t of new Set(d)) df.set(t, (df.get(t) ?? 0) + 1);
  const k1 = 1.2, b = 0.75;
  return docs.map(d => {
    const tf = new Map<string, number>();
    for (const t of d) tf.set(t, (tf.get(t) ?? 0) + 1);
    let score = 0;
    for (const t of q) {
      const f = tf.get(t) ?? 0; if (!f) continue;
      const idf = Math.log(1 + (N - (df.get(t) ?? 0) + 0.5) / ((df.get(t) ?? 0) + 0.5));
      score += idf * (f * (k1 + 1)) / (f + k1 * (1 - b + b * d.length / avgLen));
    }
    return score;
  });
}

/** Reciprocal Rank Fusion: combine several ranked lists (best-first index
 * arrays) into one score map. The standard, robust hybrid-fusion method. */
export function rrfFuse(rankings: number[][], k = 60): Map<number, number> {
  const out = new Map<number, number>();
  for (const list of rankings) list.forEach((idx, rank) => out.set(idx, (out.get(idx) ?? 0) + 1 / (k + rank + 1)));
  return out;
}

/** Import-graph adjacency from the structural index: file -> set of files it
 * imports or that import it, resolved by basename (monorepo-relative imports
 * rarely carry full paths). Used to boost neighbours of top retrieval hits. */
export function importAdjacency(files: { path: string; imports: string[] }[]): Map<string, Set<string>> {
  const byBase = new Map<string, string>();
  for (const f of files) byBase.set(path.basename(f.path).replace(/\.(ts|tsx|js|jsx|dart|py)$/, ""), f.path);
  const adj = new Map<string, Set<string>>();
  const link = (a: string, b: string) => { let s = adj.get(a); if (!s) adj.set(a, s = new Set()); s.add(b); };
  for (const f of files) for (const imp of f.imports) {
    const base = imp.split("/").pop()!.replace(/\.(ts|tsx|js|jsx|dart|py)$/, "");
    const target = byBase.get(base);
    if (target && target !== f.path) { link(f.path, target); link(target, f.path); }
  }
  return adj;
}
