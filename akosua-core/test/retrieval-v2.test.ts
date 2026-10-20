import { test } from "node:test";
import assert from "node:assert/strict";
import { TrigramIndex, queryTrigrams, bm25Scores, rrfFuse, importAdjacency } from "../src/context/retrieval.js";
import { HashEmbedder, VoyageEmbedder, embedWithCache, semanticSearch, chunkText, type Chunk } from "../src/context/semantic.js";

test("R3 trigram index: candidates are a true superset of matches", () => {
  const idx = TrigramIndex.build(new Map([
    ["a.ts", "export function createOrder(dto) { return saveOrder(dto); }"],
    ["b.ts", "export function listUsers() { return db.users.findMany(); }"],
    ["c.ts", "const x = 'payment retry logic with exponential backoff';"],
  ]));
  const cands = idx.candidates("createOrder")!;
  assert.ok(cands.includes("a.ts") && !cands.includes("b.ts"), `candidates: ${cands}`);
  assert.deepEqual(idx.candidates("zzzqqq"), []); // impossible trigram -> no files
  assert.equal(queryTrigrams("ab"), undefined); // too short to pre-filter
});

test("R4 BM25: exact identifier beats semantic neighbours", () => {
  const chunks: Chunk[] = [
    { path: "orders.ts", startLine: 1, symbol: "createOrder", text: "export function createOrder(dto) { return this.repo.save(dto); }" },
    { path: "notes.ts", startLine: 1, text: "how to create an order in the system, ordering overview and order history" },
  ];
  const scores = bm25Scores("createOrder", chunks);
  assert.ok(scores[0] > scores[1], `bm25 ${scores}`);
});

test("R4 RRF fusion merges rankings sanely", () => {
  const fused = rrfFuse([[0, 1, 2], [2, 1, 0]]);
  // Perfectly opposed rankings: all three land within a hair of each other,
  // and the consensus middle item is never last by a meaningful margin.
  const vals = [fused.get(0)!, fused.get(1)!, fused.get(2)!];
  assert.ok(Math.max(...vals) - Math.min(...vals) < 0.001, `rrf spread ${vals}`);
});

test("R2 embedding cache: identical chunk content is never embedded twice", async () => {
  let calls = 0;
  const counting = { id: "counting", async embed(texts: string[]) { calls += texts.length; return texts.map(() => [1, 0]); } };
  const chunks: Chunk[] = [
    { path: "a.ts", startLine: 1, text: "same content" },
    { path: "moved/a.ts", startLine: 1, text: "same content" }, // same content, new path -> embed text includes path, so this IS a miss by design
    { path: "a.ts", startLine: 9, text: "same content" },        // identical embed text -> cache hit
  ];
  const cache: Record<string, number[]> = {};
  await embedWithCache(counting, chunks, cache);
  const afterFirst = calls;
  assert.ok(afterFirst <= 2, `embedded ${afterFirst} of 3 (one exact duplicate must hit)`);
  await embedWithCache(counting, chunks, cache);
  assert.equal(calls, afterFirst, "second pass must be all cache hits");
});

test("R2 Voyage embedder: correct endpoint, model and payload (fake fetch)", async () => {
  let seen: { url: string; body: any } | undefined;
  const fakeFetch = async (url: any, init: any) => {
    seen = { url: String(url), body: JSON.parse(init.body) };
    return { ok: true, json: async () => ({ data: [{ embedding: [0.1, 0.2] }] }) } as any;
  };
  const v = new VoyageEmbedder(async () => "test-key", "voyage-code-4", fakeFetch as any);
  const out = await v.embed(["hello code"]);
  assert.deepEqual(out, [[0.1, 0.2]]);
  assert.equal(seen!.url, "https://api.voyageai.com/v1/embeddings");
  assert.equal(seen!.body.model, "voyage-code-4");
  assert.equal(seen!.body.input_type, "document");
  assert.equal(v.id, "voyage:voyage-code-4");
});

test("R4 semanticSearch: fused ranking finds the defining chunk first", async () => {
  const emb = new HashEmbedder();
  const chunks: Chunk[] = [
    ...chunkText("src/orders/orders.service.ts", "export class OrdersService {\n  async createOrder(dto) { await this.repo.save(dto); await this.events.emit('order.created', dto); }\n  async findOne(id) { return this.repo.find(id); }\n}"),
    ...chunkText("src/users/users.service.ts", "export class UsersService {\n  async registerUser(dto) { return this.repo.save(dto); }\n}"),
    ...chunkText("docs/readme-notes.ts", "// ordering guide: how orders flow through the system, order creation overview, order order order"),
  ];
  const vectors = await emb.embed(chunks.map(c => `${c.path} ${c.symbol ?? ""}\n${c.text}`));
  const hits = await semanticSearch({ chunks, vectors }, emb, "createOrder", 3);
  assert.ok(hits.length > 0);
  assert.ok(hits[0].chunk.path.includes("orders.service"), `top hit: ${hits[0].chunk.path}`);
});

test("R4 import adjacency links importer and imported files", () => {
  const adj = importAdjacency([
    { path: "src/orders.controller.ts", imports: ["./orders.service", "@nestjs/common"] },
    { path: "src/orders.service.ts", imports: ["./orders.repository"] },
    { path: "src/orders.repository.ts", imports: [] },
  ]);
  assert.ok(adj.get("src/orders.controller.ts")?.has("src/orders.service.ts"));
  assert.ok(adj.get("src/orders.service.ts")?.has("src/orders.repository.ts"));
  assert.ok(adj.get("src/orders.service.ts")?.has("src/orders.controller.ts")); // symmetric
});

test("R1 chunker: chunks carry endLine and respect symbol boundaries", () => {
  const chunks = chunkText("a.ts", "export function alpha() {\n  return 1;\n}\nexport function beta() {\n  return 2;\n}");
  assert.ok(chunks.length >= 1);
  for (const c of chunks) assert.ok(typeof c.endLine === "number" && c.endLine! >= c.startLine, `chunk lines ${c.startLine}..${c.endLine}`);
  assert.ok(chunks.some(c => (c.symbol ?? "").includes("alpha")));
});
