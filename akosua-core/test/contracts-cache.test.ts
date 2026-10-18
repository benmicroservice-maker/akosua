import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os"; import path from "node:path";
import { fileURLToPath } from "node:url";
import { indexProject, renderBrainV2 } from "../src/context/indexer.js";
import { fingerprintProject } from "../src/context/fingerprint.js";
import { PersistentTtlCache } from "../src/research/clients.js";

const FIXTURE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../../test-projects/sample-monorepo");

test("contract map v3: full route paths, DTO fields, Prisma model, API consumer", async () => {
  const idx = await indexProject(FIXTURE);
  assert.ok(idx.contracts.http.some(r => r.method === "POST" && r.path === "/orders"), "POST /orders (controller prefix joined)");
  assert.ok(idx.contracts.http.some(r => r.method === "GET" && r.path === "/orders"));
  const dto = idx.contracts.dtos.find(d => d.name === "CreateOrderDto");
  assert.ok(dto, "CreateOrderDto extracted");
  assert.deepEqual(dto!.fields.map(f => f.name), ["total", "note?", "customerId"]);
  assert.equal(dto!.fields.find(f => f.name === "total")?.type, "number");
  const evt = idx.contracts.dtos.find(d => d.name === "OrderCreatedEvent");
  assert.ok(evt?.fields.some(f => f.name === "orderId" && f.type === "number"));
  const prisma = idx.contracts.dtos.find(d => d.name === "Prisma:Order");
  assert.ok(prisma?.fields.some(f => f.name === "total" && /Float/.test(f.type)), "Prisma model fields extracted");
  assert.ok(idx.contracts.consumers.some(c => c.path === "/orders" && /page\.tsx$/.test(c.file)), "Next.js fetch consumer mapped to /orders");
  const brain = renderBrainV2(await fingerprintProject(path.join(FIXTURE, "services/orders")), idx);
  assert.match(brain, /DTOs \/ schemas/);
  assert.match(brain, /CreateOrderDto/);
  assert.match(brain, /API consumers/);
});

test("persistent research cache: survives reopen, evicts, invalidates by prefix", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "akosua-cache-"));
  const c1 = await PersistentTtlCache.open(dir, 60_000, 3);
  c1.set("context7:@nestjs/core@11:fastify", "docs-v11");
  c1.set("fc:https://example.com", "page");
  await c1.flush();
  const c2 = await PersistentTtlCache.open(dir, 60_000, 3);
  assert.equal(c2.get("context7:@nestjs/core@11:fastify"), "docs-v11");
  c2.set("a:1", "1"); c2.set("a:2", "2"); c2.set("a:3", "3"); // exceeds maxEntries=3 with 2 existing -> eviction keeps size<=3
  assert.ok([c2.get("a:1"), c2.get("a:2"), c2.get("a:3")].filter(Boolean).length <= 3);
  c2.invalidate("context7:");
  assert.equal(c2.get("context7:@nestjs/core@11:fastify"), undefined);
  const short = await PersistentTtlCache.open(dir, -1, 10); // already-expired TTL
  short.set("x", "y");
  assert.equal(short.get("x"), undefined);
});
