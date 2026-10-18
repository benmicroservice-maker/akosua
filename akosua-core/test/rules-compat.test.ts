import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { buildAkosuaAgent } from "../src/agent/assemble.js";

test("AGENTS.md rules reach the system prompt (compat import)", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "akosua-rules-"));
  fs.writeFileSync(path.join(dir, "AGENTS.md"), "Always run migrations before tests in this repo.");
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "x" }));
  const secrets = { get: async () => undefined, set: async () => undefined, delete: async () => undefined };
  const provider = { id: "openai" as const, async *complete() { yield { type: "done" as const, stopReason: "end" }; } };
  const bundle = await buildAkosuaAgent({ secrets, provider, model: "m", workspaceRoot: dir });
  const system = bundle.agent.history.find(m => m.role === "system")?.content ?? "";
  assert.match(system, /Imported project rules \(AGENTS\.md/);
  assert.match(system, /Always run migrations/);
  await bundle.close();
});
