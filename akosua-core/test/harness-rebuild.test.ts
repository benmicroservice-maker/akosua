import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { classifyIntent } from "../src/agent/intent.js";
import { Agent } from "../src/agent/loop.js";
import { ToolRegistry } from "../src/agent/tools.js";
import type { ModelProvider } from "../src/providers/types.js";
import { fingerprintProject, brainBrief, renderProjectBrain } from "../src/context/fingerprint.js";

/** Harness rebuild (2026-10-20) — the user's verdict, as tests:
 * (1) "how are you" must NOT run the five-phase ceremony;
 * (2) questions get read-only investigation, not a plan gate;
 * (3) the Brain must recognise a Flutter/Dart project as Dart;
 * (4) the agent must start oriented (brain brief), not blind. */

test("intent lanes: chat / ask / act routing is conservative and correct", () => {
  const cases: [string, string][] = [
    ["how are you", "chat"], ["Hello!", "chat"], ["thanks", "chat"], ["who are you?", "chat"],
    ["what does the orders service do?", "ask"], ["why is the cart total wrong?", "ask"],
    ["explain how auth works in this repo", "ask"], ["how do I run this app?", "ask"],
    ["where is the checkout logic?", "ask"],
    ["let start this app", "act"], ["fix the login bug", "act"], ["create result.txt", "act"],
    ["add a health endpoint", "act"], ["so you cant use terminal", "act"],
    ["PLAN APPROVED: proceed", "act"], ["task", "ask"],
    ["start this app\n\n# Editor context (implicit)\n- Active file: App.tsx", "act"],
  ];
  for (const [text, lane] of cases) assert.equal(classifyIntent(text).lane, lane, `"${text.slice(0, 40)}" -> ${lane}`);
});

test("chat lane: exactly ONE model call, no tools offered, run ends", async () => {
  const calls: { tools?: unknown }[] = [];
  const provider: ModelProvider = { id: "openai", async *complete(req) {
    calls.push({ tools: req.tools });
    yield { type: "text", delta: "I am well — ready when you are." };
    yield { type: "done", stopReason: "stop" };
  } };
  const agent = new Agent({ provider, model: "m", systemPrompt: "s" }, new ToolRegistry(), "/tmp");
  const events: string[] = [];
  for await (const e of agent.run("how are you")) events.push(e.type);
  assert.equal(calls.length, 1, "one call only — no ceremony");
  assert.equal(calls[0].tools, undefined, "no tools offered in chat lane");
  assert.deepEqual(events, ["text", "done"]);
});

test("ask lane: read-only tools only, first full answer ends the run (no gates)", async () => {
  const offered: string[][] = [];
  let turn = 0;
  const provider: ModelProvider = { id: "openai", async *complete(req) {
    turn++;
    offered.push((req.tools ?? []).map(t => t.name));
    if (turn === 1) yield { type: "toolCall", call: { id: "c1", name: "search_code", arguments: "{}" } };
    else yield { type: "text", delta: "The orders service lives in src/orders and validates DTOs at the boundary." };
    yield { type: "done", stopReason: "stop" };
  } };
  const registry = new ToolRegistry();
  registry.register({ definition: { name: "search_code", description: "s", parameters: { type: "object", properties: {} } }, phases: ["understand"], run: async () => "hits" });
  registry.register({ definition: { name: "file_editor", description: "e", parameters: { type: "object", properties: {} } }, phases: ["build"], run: async () => "edited" });
  const agent = new Agent({ provider, model: "m", systemPrompt: "s" }, registry, "/tmp");
  const events: string[] = [];
  for await (const e of agent.run("what does the orders service do?")) events.push(e.type);
  assert.ok(offered.flat().includes("search_code"));
  assert.ok(!offered.flat().includes("file_editor"), "hands are never offered in ask lane");
  assert.equal(events[events.length - 1], "done");
  assert.equal(turn, 2, "answer ended the run immediately — no sign-off nudges");
});

test("Flutter fixture: pubspec project is detected as Dart/Flutter/Riverpod", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "akosua-fl-"));
  await fs.mkdir(path.join(dir, "lib", "features"), { recursive: true });
  await fs.writeFile(path.join(dir, "pubspec.yaml"), "name: shop\nenvironment:\n  sdk: ^3.5.0\ndependencies:\n  flutter:\n    sdk: flutter\n  flutter_riverpod: ^2.5.0\n");
  await fs.writeFile(path.join(dir, "lib", "main.dart"), "void main() {}\n");
  await fs.writeFile(path.join(dir, "lib", "features", "cart.dart"), "class Cart {}\n");
  await fs.writeFile(path.join(dir, "README.md"), "# shop\n");
  const fp = await fingerprintProject(dir);
  assert.equal(fp.mobile?.framework, "flutter");
  assert.equal(fp.mobile?.state, "riverpod");
  assert.ok((fp.languageCounts?.dart ?? 0) >= 2, "census counts Dart files");
  assert.ok(fp.verifyCommands.some(c => c.includes("flutter analyze")), "flutter verify command detected");
  const brief = brainBrief(fp);
  assert.match(brief, /Primary language: Dart/);
  assert.match(brief, /flutter/i);
  assert.match(renderProjectBrain(fp, "- lib/main.dart"), /Primary language: Dart/);
});

test("Flutter fallback: Dart-dominant tree without pubspec is still called Dart (labelled)", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "akosua-fl2-"));
  await fs.mkdir(path.join(dir, "lib"), { recursive: true });
  for (let i = 0; i < 6; i++) await fs.writeFile(path.join(dir, "lib", `f${i}.dart`), "class X {}\n");
  await fs.writeFile(path.join(dir, "lib", "note.ts"), "export {};\n");
  const fp = await fingerprintProject(dir);
  assert.equal(fp.mobile?.framework, "flutter");
  assert.match(fp.flutterDetectedFrom ?? "", /dart-source-dominance/);
});
