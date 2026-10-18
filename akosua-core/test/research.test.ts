import test from "node:test";
import assert from "node:assert/strict";
import { InMemorySecretStore, SecretKeys } from "../src/secrets.js";
import { Context7Client, FirecrawlClient, YouTubeKnowledgeClient } from "../src/research/clients.js";

const jsonRes = (obj: unknown, status = 200) => ({
  ok: status < 400, status, text: async () => JSON.stringify(obj),
  json: async () => obj, body: null,
});
const textRes = (s: string, status = 200) => ({
  ok: status < 400, status, text: async () => s, json: async () => { throw new Error("not json"); }, body: null,
});

test("Context7: resolves library then fetches version-pinned docs, with cache", async () => {
  const secrets = new InMemorySecretStore(); await secrets.set(SecretKeys.context7, "ctx-test");
  const calls: string[] = [];
  const fetchFn = async (url: string) => {
    calls.push(url);
    if (url.includes("/search")) return jsonRes({ results: [{ id: "/nestjs/docs" }] });
    if (url.includes("/context")) return textRes("NestJS Fastify adapter docs (v11)");
    throw new Error("unexpected " + url);
  };
  const c = new Context7Client(secrets, undefined, fetchFn as never);
  const out = await c.docs("@nestjs/platform-fastify", "11.0.0", "fastify adapter");
  assert.match(out, /Context7 \(@nestjs\/platform-fastify@11\.0\.0\)/);
  assert.match(out, /Fastify adapter docs/);
  await c.docs("@nestjs/platform-fastify", "11.0.0", "fastify adapter"); // cached
  assert.equal(calls.filter(u => u.includes("/context?")).length, 1);
});

test("Firecrawl: scrape returns markdown labelled with source", async () => {
  const secrets = new InMemorySecretStore(); await secrets.set(SecretKeys.firecrawl, "fc-test");
  const c = new FirecrawlClient(secrets, undefined, (async () => jsonRes({ data: { markdown: "# Solution" } })) as never);
  assert.match(await c.scrape("https://stackoverflow.com/q/1"), /Firecrawl scrape of https:\/\/stackoverflow\.com/);
});

test("YouTube: learn returns IDEAS-ONLY labelled transcript", async () => {
  const secrets = new InMemorySecretStore(); await secrets.set(SecretKeys.transcriptApi, "ta-test");
  const c = new YouTubeKnowledgeClient(secrets, undefined, (async () =>
    jsonRes({ metadata: { title: "Fix NestJS Fastify bug" }, transcript: "[00:01:23] do X" })) as never);
  const out = await c.learn("VIDEOID1234");
  assert.match(out, /IDEAS ONLY, verify before applying/);
  assert.match(out, /Fix NestJS Fastify bug/);
});

test("missing keys produce actionable Settings errors (never silent)", async () => {
  const c = new FirecrawlClient(new InMemorySecretStore());
  await assert.rejects(() => c.scrape("https://example.com"), /Firecrawl API key not set \(Settings/);
});
