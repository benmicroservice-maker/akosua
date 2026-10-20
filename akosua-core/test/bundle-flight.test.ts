import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { buildAkosuaAgent } from "../src/agent/assemble.js";
import type { ModelProvider } from "../src/providers/types.js";

test("buildAkosuaAgent records bundle.ready (embedder, rules, stack) on the flight tap", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "akosua-bundle-"));
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "x", dependencies: { "@nestjs/core": "^10.0.0" } }));
  fs.writeFileSync(path.join(root, "AKOSUA_RULES.md"), "# rules\nBe careful.\n");
  const events: { type: string; data: Record<string, unknown> }[] = [];
  const flight = { record: (type: string, data: Record<string, unknown> = {}) => { events.push({ type, data }); } };
  const secrets = { get: async () => undefined, set: async () => {}, delete: async () => {} } as never;
  const provider: ModelProvider = { id: "openai", async *complete() { yield { type: "done" as const, stopReason: "stop" }; } };
  const bundle = await buildAkosuaAgent({ secrets, provider, model: "fake", workspaceRoot: root, flight });
  try {
    const ready = events.find(e => e.type === "bundle.ready");
    assert.ok(ready, `missing bundle.ready; got ${events.map(e => e.type).join(",")}`);
    assert.equal(ready!.data.embedder, "hash-local"); // stable Embedder.id (constructor.name is minified away in the shipped bundle)
    assert.deepEqual(ready!.data.mcpConnected, []);
    const rules = ready!.data.rulesLoaded as { akosuaRules: boolean };
    assert.equal(rules.akosuaRules, true);
    assert.equal((ready!.data.stack as { backend?: string }).backend, "nestjs");
  } finally { await bundle.close(); }
});
