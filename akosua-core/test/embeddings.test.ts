import { test } from "node:test";
import assert from "node:assert/strict";
import { OpenAIEmbedder, hybridScore, type Chunk } from "../src/context/semantic.js";

test("OpenAIEmbedder: batches, maps vectors, throws on failure (fallback signal)", async () => {
  const calls: number[] = [];
  const fakeFetch = async (_url: string, init: { body: string }) => {
    const body = JSON.parse(init.body) as { input: string[] };
    calls.push(body.input.length);
    return { ok: true, status: 200, json: async () => ({ data: body.input.map((_, i) => ({ embedding: [i, i + 1] })) }) };
  };
  const emb = new OpenAIEmbedder(async () => "k", fakeFetch as never);
  const many = Array.from({ length: 130 }, (_, i) => `t${i}`);
  const vectors = await emb.embed(many);
  assert.equal(vectors.length, 130);
  assert.deepEqual(calls, [64, 64, 2]);
  await assert.rejects(new OpenAIEmbedder(async () => undefined, fakeFetch as never).embed(["x"]), /no OpenAI key/);
});

test("hybridScore: exact symbol match beats pure semantic similarity", () => {
  const sym: Chunk = { path: "src/orders.ts", startLine: 1, symbol: "createOrder", text: "export function createOrder(dto) { return repo.save(dto); }" };
  const other: Chunk = { path: "src/misc.ts", startLine: 1, text: "unrelated purchase flow wording" };
  assert.ok(hybridScore("createOrder", sym, 0.4) > hybridScore("createOrder", other, 0.4));
});
