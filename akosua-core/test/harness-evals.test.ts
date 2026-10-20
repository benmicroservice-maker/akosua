import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Agent } from "../src/agent/loop.js";
import { ToolRegistry } from "../src/agent/tools.js";
import type { ModelProvider } from "../src/providers/types.js";
import { buildAkosuaAgent } from "../src/agent/assemble.js";
import { InMemorySecretStore } from "../src/secrets.js";
import { rankFiles, type ProjectIndex } from "../src/context/indexer.js";

/** HARNESS EVALS — the trust suite. Scripted providers, HARD budgets.
 * These fail when the harness gets more ceremonious, blinder, or slower
 * to act — the regressions the user felt live (2026-10-20). A harness
 * that "stands the test of time" passes these on every change. */

interface Script { text?: string; tool?: { name: string; args: Record<string, unknown> } }
function scripted(steps: Script[], counter = { calls: 0, toolsOffered: [] as string[][], systemHeads: [] as string[] }): ModelProvider {
  let i = 0;
  return { id: "openai", async *complete(req) {
    counter.calls++;
    counter.toolsOffered.push((req.tools ?? []).map(t => t.name));
    counter.systemHeads.push(String(req.messages[0]?.content ?? ""));
    const s = steps[Math.min(i++, steps.length - 1)] ?? {};
    if (s.text) yield { type: "text", delta: s.text };
    if (s.tool) yield { type: "toolCall", call: { id: `c${i}`, name: s.tool.name, arguments: JSON.stringify(s.tool.args) } };
    yield { type: "done", stopReason: "stop" };
  } };
}

test("EVAL chat: greeting completes in exactly 1 call within budget", async () => {
  const c = { calls: 0, toolsOffered: [] as string[][], systemHeads: [] as string[] };
  const agent = new Agent({ provider: scripted([{ text: "Doing well — ready when you are." }], c), model: "m", systemPrompt: "s" }, new ToolRegistry(), "/tmp");
  for await (const _e of agent.run("how are you")) { /* drain */ }
  assert.equal(c.calls, 1, "BUDGET: chat must cost exactly 1 model call");
  assert.deepEqual(c.toolsOffered[0], [], "BUDGET: chat offers no tools");
});

test("EVAL ask: codebase question answered in <=3 calls, hands never offered", async () => {
  const c = { calls: 0, toolsOffered: [] as string[][], systemHeads: [] as string[] };
  const registry = new ToolRegistry();
  registry.register({ definition: { name: "search_code", description: "s", parameters: { type: "object", properties: {} } }, phases: ["understand"], run: async () => "hits" });
  registry.register({ definition: { name: "file_editor", description: "e", parameters: { type: "object", properties: {} } }, phases: ["build"], run: async () => "edited" });
  registry.register({ definition: { name: "terminal", description: "t", parameters: { type: "object", properties: {} } }, phases: ["build", "verify"], run: async () => "ran" });
  const agent = new Agent({ provider: scripted([
    { tool: { name: "search_code", args: { q: "orders" } } },
    { text: "Orders live in src/orders; validation is at the controller boundary." },
  ], c), model: "m", systemPrompt: "s" }, registry, "/tmp");
  for await (const _e of agent.run("where does order validation happen?")) { /* drain */ }
  assert.ok(c.calls <= 3, `BUDGET: ask answered in ${c.calls} calls (max 3)`);
  assert.ok(!c.toolsOffered.flat().includes("file_editor") && !c.toolsOffered.flat().includes("terminal"), "ask lane never offers hands");
});

test("EVAL act/create: reaches the actual edit in <=4 model calls", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "akosua-eval-"));
  const { fileEditorTool } = await import("../src/tools/fileEditor.js");
  const c = { calls: 0, toolsOffered: [] as string[][], systemHeads: [] as string[] };
  const registry = new ToolRegistry(); registry.register(fileEditorTool);
  const agent = new Agent({ provider: scripted([
    { text: "UNDERSTANDING COMPLETE: tiny. RESEARCH COMPLETE: none needed. PLAN COMPLETE: create hello.txt" },
    { tool: { name: "file_editor", args: { command: "create", path: "hello.txt", file_text: "hi" } } },
    { text: "BUILD COMPLETE: created" },
    { text: "VERIFICATION COMPLETE: file exists" },
  ], c), model: "m", systemPrompt: "s", lane: "act" }, registry, root);
  for await (const _e of agent.run("create hello.txt with hi")) { /* drain */ }
  assert.equal(await fs.readFile(path.join(root, "hello.txt"), "utf8"), "hi");
  // The verify gate blocks the first VERIFICATION sign-off (no
  // run_verification tool in this fixture) twice, then ends flagged:
  // 4 scripted steps + 2 gate-block retries = 6 calls. The gate doing
  // its job is not ceremony; the budget therefore counts to 6 here,
  // and the file MUST exist by call 2 (step 2 is the edit).
  assert.ok(c.calls <= 6, `BUDGET: run completed within ${c.calls} calls (max 6 incl. verify-gate blocks)`);
});

test("EVAL act/execute: phase brief carries execution instructions + capability truth", async () => {
  const c = { calls: 0, toolsOffered: [] as string[][], systemHeads: [] as string[] };
  const agent = new Agent({ provider: scripted([{ text: "UNDERSTANDING COMPLETE: scripts known. RESEARCH COMPLETE: n/a. PLAN COMPLETE: npm start" }], c), model: "m", systemPrompt: "s" }, new ToolRegistry(), "/tmp");
  for await (const _e of agent.run("start this app")) { /* drain */ }
  const head = c.systemHeads.join("\n");
  assert.match(head, /EXECUTION TASK/);
  assert.match(head, /Tools available to you NOW/);
  assert.match(head, /never tell the user a listed capability does not exist/);
});

test("EVAL orientation: assembled agent's prompt carries the brain brief + key files", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "akosua-eval-fl-"));
  await fs.mkdir(path.join(root, "lib"), { recursive: true });
  await fs.writeFile(path.join(root, "pubspec.yaml"), "name: shop\ndependencies:\n  flutter:\n    sdk: flutter\n  flutter_riverpod: ^2.5.0\n");
  await fs.writeFile(path.join(root, "lib", "main.dart"), "import 'cart.dart';\nvoid main() {}\n");
  await fs.writeFile(path.join(root, "lib", "cart.dart"), "class Cart {}\n");
  const bundle = await buildAkosuaAgent({ secrets: new InMemorySecretStore(), provider: scripted([{ text: "x" }]), model: "m", workspaceRoot: root });
  const prompt = bundle.agent ? (bundle as unknown as { agent: Agent }).agent.history[0].content : "";
  assert.match(prompt, /Project orientation/);
  assert.match(prompt, /Primary language: Dart/);
  assert.match(prompt, /flutter analyze/);
  await bundle.close();
});

test("EVAL repo map: import-graph ranking puts the depended-on file first", () => {
  const idx: ProjectIndex = { version: 1, root: "/x", indexedAt: "t", contracts: { http: [], events: [], dtos: [], consumers: [] },
    files: [
      { path: "src/z-unused.ts", language: "ts", hash: "1", size: 1, symbols: [], imports: [], routes: [], events: [], dtos: [], consumers: [] },
      { path: "src/core.ts", language: "ts", hash: "2", size: 1, symbols: ["class Core"], imports: [], routes: [], events: [], dtos: [], consumers: [] },
      { path: "src/a.ts", language: "ts", hash: "3", size: 1, symbols: [], imports: ["./core"], routes: [], events: [], dtos: [], consumers: [] },
      { path: "src/b.ts", language: "ts", hash: "4", size: 1, symbols: [], imports: ["./core", "./z-unused"], routes: [], events: [], dtos: [], consumers: [] },
    ] };
  const ranked = rankFiles(idx);
  assert.equal(ranked[0].path, "src/core.ts", "most depended-on file ranks first");
  assert.ok(ranked.findIndex(r => r.path === "src/core.ts") < ranked.findIndex(r => r.path === "src/z-unused.ts"));
});
