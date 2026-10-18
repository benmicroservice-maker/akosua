import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os"; import path from "node:path";
import { buildAkosuaAgent } from "../src/agent/assemble.js";
import { InMemorySecretStore } from "../src/secrets.js";
import { listFilesTool, searchCodeTool, projectBrainTool } from "../src/tools/codebaseTools.js";
import type { ModelProvider } from "../src/providers/types.js";

function scripted(turns: Array<{ text?: string; tool?: { name: string; args?: object } }>): ModelProvider {
  let i = 0;
  return { id: "anthropic", async *complete() {
    const t = turns[Math.min(i++, turns.length - 1)];
    if (t.text) yield { type: "text", delta: t.text };
    if (t.tool) yield { type: "toolCall", call: { id: "c" + i, name: t.tool.name, arguments: JSON.stringify(t.tool.args ?? {}) } };
    yield { type: "done", stopReason: "stop" };
  }};
}

test("assembled agent walks all 5 phases with gated tools on a real temp project", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "akosua-e2e-"));
  await fs.writeFile(path.join(root, "package.json"), JSON.stringify({ scripts: { test: "node -e \"process.exit(0)\"" }, dependencies: { express: "^4.0.0" } }));
  await fs.writeFile(path.join(root, "hello.ts"), "export const greet = () => 'hi';\n");

  const bundle = await buildAkosuaAgent({
    secrets: new InMemorySecretStore(), model: "fake",
    workspaceRoot: root,
    provider: scripted([
      { tool: { name: "project_brain" } },
      { text: "It is a tiny TS project with hello.ts. UNDERSTANDING COMPLETE: express app skeleton" },
      { text: "No library APIs needed beyond local code. RESEARCH COMPLETE: local only" },
      { text: "Create result.txt via editor. PLAN APPROVED: one file" },
      { tool: { name: "file_editor", args: { command: "create", path: "result.txt", file_text: "verified" } } },
      { text: "BUILD COMPLETE: result.txt created" },
      { tool: { name: "run_verification" } },
      { text: "VERIFICATION COMPLETE: run_verification passed (see evidence above)" },
    ]),
  });
  const { agent, fingerprint } = bundle;
  assert.equal(fingerprint.backend?.framework, "express");
  const phases: string[] = []; const tools: string[] = [];
  for await (const e of agent.run("create result.txt")) {
    if (e.type === "phase" && phases[phases.length - 1] !== e.phase) phases.push(e.phase);
    if (e.type === "tool") tools.push(e.name);
  }
  assert.deepEqual(phases, ["understand", "research", "plan", "build", "verify"]);
  assert.deepEqual(tools, ["project_brain", "file_editor", "run_verification"]);
  assert.equal(await fs.readFile(path.join(root, "result.txt"), "utf8"), "verified");
  await bundle.close(); // persistent terminals must not leak (would hang the host)
});

test("codebase tools prove presence AND absence honestly", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "akosua-cb-"));
  await fs.writeFile(path.join(root, "a.ts"), "export class OrdersService {}\n");
  const ctx = { workspaceRoot: root };
  assert.match(await listFilesTool.run({}, ctx, "understand"), /a\.ts/);
  assert.match(await searchCodeTool.run({ query: "OrdersService" }, ctx, "understand"), /a\.ts:1/);
  assert.match(await searchCodeTool.run({ query: "PaymentsService" }, ctx, "understand"), /No matches.*evidence/);
  const brain = await projectBrainTool.run({}, ctx, "understand");
  assert.match(brain, /## Contract map/);
});
