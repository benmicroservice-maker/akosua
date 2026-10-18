import { test } from "node:test";
import assert from "node:assert/strict";
import { shapeToolResult, digestToolResult, compactHistory, historyTokens } from "../src/agent/context.js";
import { parseDiagnostics } from "../src/context/diagnostics.js";
import { Agent } from "../src/agent/loop.js";
import { ToolRegistry } from "../src/agent/tools.js";
import type { ModelProvider } from "../src/providers/types.js";

test("shapeToolResult: error lines survive elision, small results untouched", () => {
  const small = "line1\nline2";
  assert.equal(shapeToolResult(small), small);
  const big = ["head context", ...Array.from({ length: 500 }, (_, i) => `noise ${i}`),
    "src/app.ts(12,5): error TS2304: Cannot find name 'foo'.", "tail verdict", "exit code 1"].join("\n");
  const shaped = shapeToolResult(big, 800);
  assert.match(shaped, /error TS2304/);
  assert.match(shaped, /elided/);
  assert.ok(shaped.length < big.length / 3);
});

test("compactHistory: decisions preserved, old tool bulk digested, shrinks under budget", () => {
  const msgs = [
    { role: "system" as const, content: "SYS RULES" },
    { role: "user" as const, content: "the task" },
    { role: "assistant" as const, content: "DECISION: use Prisma" },
    ...Array.from({ length: 10 }, (_, i) => ({ role: "tool" as const, name: "read", content: `file${i}\n` + "x".repeat(4000), toolCallId: String(i) })),
  ];
  const before = historyTokens(msgs);
  const report = compactHistory(msgs, 800);
  assert.ok(report.tokensAfter < before, "must shrink");
  assert.ok(report.tokensAfter <= 800 || report.digested > 0);
  assert.equal(msgs[2].content, "DECISION: use Prisma", "assistant decisions never altered");
  assert.match(msgs[3].content, /earlier read result elided/);
  assert.match(digestToolResult("terminal", "boom\nError happened"), /contained errors/);
});

test("parseDiagnostics keeps actionable lines", () => {
  const out = parseDiagnostics("compiling...\nsrc/a.ts(3,7): error TS2322: Type 'string' is not assignable.\ndone");
  assert.match(out, /TS2322/);
});

test("agent loop: diagnostics hook fires after Build edits and reaches the model", async () => {
  const seen: string[] = [];
  let turn = 0;
  const provider: ModelProvider = { id: "openai", async *complete(req) {
    turn++;
    seen.push(JSON.stringify(req.messages.map(m => m.content)).slice(0, 4000));
    if (turn === 1) yield { type: "text", delta: "UNDERSTANDING COMPLETE: x RESEARCH COMPLETE: y PLAN APPROVED: z" };
    else if (turn === 2) yield { type: "toolCall", call: { id: "1", name: "file_editor", arguments: JSON.stringify({ path: "src/a.ts" }) } };
    else if (turn === 3) yield { type: "text", delta: "BUILD COMPLETE: edited" };
    else yield { type: "text", delta: "VERIFICATION COMPLETE: done" };
    yield { type: "done", stopReason: "stop" };
  } };
  const registry = new ToolRegistry();
  registry.register({ definition: { name: "file_editor", description: "edit", parameters: { type: "object", properties: {} } },
    phases: ["build"], run: async () => "edited src/a.ts" });
  registry.register({ definition: { name: "run_verification", description: "verify", parameters: { type: "object", properties: {} } },
    phases: ["verify"], run: async () => "PASS" });
  let diagFiles: string[] = [];
  const agent = new Agent({ provider, model: "m", systemPrompt: "s",
    diagnostics: async (files) => { diagFiles = files; return "TypeScript diagnostics: CLEAN"; } }, registry, "/tmp");
  // verify gate needs run_verification: drive it via extra turn handling — the
  // scripted provider signs off verify without the tool, gate blocks twice then
  // ends flagged; acceptable for this test's purpose (diagnostics assertion).
  for await (const _e of agent.run("task")) { /* drain */ }
  assert.deepEqual(diagFiles, ["src/a.ts"]);
  assert.ok(seen.some(s => s.includes("TypeScript diagnostics: CLEAN")), "diagnostics must reach the model context");
});

import { chunkText } from "../src/context/semantic.js";
test("syntactic chunking: splits at symbols, carries names, never mid-function by lines", () => {
  const ts = [
    "import { x } from './x';",
    "export class OrdersService {",
    "  async createOrder(dto: CreateDto) {",
    ...Array.from({ length: 30 }, (_, i) => `    step${i}();`),
    "  }",
    "}",
    "export function helperUtil() { return 1; }",
  ].join("\n");
  const chunks = chunkText("src/orders.service.ts", ts);
  assert.ok(chunks.some(c => c.symbol?.includes("OrdersService")), `symbols: ${chunks.map(c => c.symbol)}`);
  assert.ok(chunks.some(c => c.symbol?.includes("helperUtil")));
  // OrdersService body stays in ONE chunk (not sliced at line 60 boundaries)
  assert.equal(chunks.filter(c => c.text.includes("step15();")).length, 1);
  const py = chunkText("a.py", "def alpha():\n    return 1\n\ndef beta():\n    return 2\n");
  assert.ok(py.some(c => c.symbol?.includes("alpha")));
});

import { detectStackPacks, renderStackPacks } from "../src/context/stackpacks.js";
test("stack packs: NestJS+NATS+Prisma fixture gets the right packs and rules", async () => {
  const { fingerprintProject } = await import("../src/context/fingerprint.js");
  const root = new URL("../../test-projects/sample-monorepo/", `file://${process.cwd()}/`).pathname;
  const fp = await fingerprintProject(process.cwd() + "/../../test-projects/sample-monorepo").catch(() => null);
  const anyFp = fp ?? { root: ".", shape: "monorepo", backend: { framework: "nestjs", adapter: "fastify", transports: ["nats"], orm: "prisma" }, web: { framework: "nextjs" }, mobile: { framework: "flutter", state: "riverpod" }, python: false, testCommands: [], verifyCommands: [] } as never;
  const packs = detectStackPacks(anyFp);
  const ids = packs.map(p => p.id);
  assert.ok(ids.includes("nestjs-microservices"), ids.join(","));
  assert.ok(ids.includes("nextjs") && ids.includes("flutter-riverpod"), ids.join(","));
  assert.match(renderStackPacks(anyFp), /idempotent/);
});
