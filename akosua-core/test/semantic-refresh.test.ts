import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { HashEmbedder, refreshSemanticIndex, semanticSearch } from "../src/context/semantic.js";

function fixture(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "akosua-sem-"));
  fs.writeFileSync(path.join(dir, "orders.ts"), "export function createOrder() { return placeOrderInQueue(); }\n");
  fs.writeFileSync(path.join(dir, "users.ts"), "export function listUsers() { return allUsersFromDb(); }\n");
  return dir;
}

test("refresh: cold build persists; unchanged files keep chunks on refresh", async () => {
  const dir = fixture();
  const emb = new HashEmbedder();
  const first = await refreshSemanticIndex(dir, emb);
  assert.ok(fs.existsSync(path.join(dir, ".akosua/semantic-index.json")));
  const second = await refreshSemanticIndex(dir, emb);
  assert.deepEqual(second.chunks.map(c => c.path).sort(), first.chunks.map(c => c.path).sort());
});

test("refresh: edited file re-chunked, deleted file dropped, search still ranks", async () => {
  const dir = fixture();
  const emb = new HashEmbedder();
  await refreshSemanticIndex(dir, emb);
  fs.writeFileSync(path.join(dir, "orders.ts"), "export function cancelOrder() { return refundPaymentImmediately(); }\n");
  fs.rmSync(path.join(dir, "users.ts"));
  const idx = await refreshSemanticIndex(dir, emb);
  assert.ok(!idx.chunks.some(c => c.path === "users.ts"), "deleted file chunks must be dropped");
  assert.ok(idx.chunks.some(c => c.text.includes("refundPaymentImmediately")), "edited file must be re-chunked");
  const hits = await semanticSearch(idx, emb, "refund payment", 1);
  assert.ok(hits.length >= 1);
});

test("search after refresh finds the edited content", async () => {
  const dir = fixture();
  const emb = new HashEmbedder();
  fs.writeFileSync(path.join(dir, "orders.ts"), "export function cancelOrder() { return refundPaymentImmediately(); }\n");
  const idx = await refreshSemanticIndex(dir, emb);
  const hits = await semanticSearch(idx, emb, "refund payment immediately", 2);
  assert.ok(hits.length >= 1);
  assert.match(hits[0].chunk.text, /refundPaymentImmediately/);
});
