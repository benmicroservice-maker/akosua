import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os"; import path from "node:path";
import { ToolRegistry } from "../src/agent/tools.js";
import { Agent, AKOSUA_SYSTEM_PROMPT } from "../src/agent/loop.js";
import { fileEditorTool } from "../src/tools/fileEditor.js";
import { fingerprintProject, renderProjectBrain } from "../src/context/fingerprint.js";
import type { ModelProvider } from "../src/providers/types.js";

/** Fake provider: emits scripted assistant turns (no network, no keys). */
function scripted(turns: Array<{ text?: string; tool?: { name: string; args: object } }>): ModelProvider {
  let i = 0;
  return { id: "anthropic", async *complete() {
    const t = turns[Math.min(i++, turns.length - 1)];
    if (t.text) yield { type: "text", delta: t.text };
    if (t.tool) yield { type: "toolCall", call: { id: "c" + i, name: t.tool.name, arguments: JSON.stringify(t.tool.args) } };
    yield { type: "done", stopReason: "stop" };
  }};
}

test("phase gate: edit tool is BLOCKED in understand phase, allowed after sign-offs", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "akosua-"));
  const reg = new ToolRegistry(); reg.register(fileEditorTool);
  // Creating a file during understand MUST be blocked (mutations are build-phase only)
  const blocked = await reg.run("file_editor", { command: "create", path: "a.txt", file_text: "x" }, { workspaceRoot: root }, "understand");
  assert.match(blocked, /only allowed in the "build" phase/);

  const agent = new Agent({ provider: scripted([
    { text: "Reading first. UNDERSTANDING COMPLETE: repo is empty" },
    { text: "No external libs. RESEARCH COMPLETE: none needed" },
    { text: "Make a.txt. PLAN COMPLETE: create a.txt" },
    { tool: { name: "file_editor", args: { command: "create", path: "a.txt", file_text: "hello akosua" } } },
    { text: "BUILD COMPLETE: a.txt created" },
    { text: "VERIFICATION COMPLETE: file exists (see tool output)" },
  ]), model: "fake", systemPrompt: AKOSUA_SYSTEM_PROMPT }, reg, root);
  const events: string[] = [];
  for await (const e of agent.run("create a.txt")) events.push(e.type + (e.type === "tool" ? ":" + e.name : ""));
  assert.equal(await fs.readFile(path.join(root, "a.txt"), "utf8"), "hello akosua");
  assert.ok(events.some(e => e.startsWith("tool:file_editor")));
});

test("registry refuses tools outside their phase with an instructive error", async () => {
  const reg = new ToolRegistry(); reg.register(fileEditorTool);
  const out = await reg.run("file_editor", { command: "view", path: "x" }, { workspaceRoot: "/tmp" }, "research");
  assert.match(out, /NOT available in the "research" phase/);
});

test("file_editor str_replace is surgical and rejects ambiguous matches", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "akosua-"));
  await fs.writeFile(path.join(root, "f.ts"), "const a = 1;\nconst b = 1;\n");
  const ctx = { workspaceRoot: root };
  const dup = await fileEditorTool.run({ command: "str_replace", path: "f.ts", old_str: "= 1", new_str: "= 2" }, ctx, "build");
  assert.match(dup, /more than once/);
  const ok = await fileEditorTool.run({ command: "str_replace", path: "f.ts", old_str: "const a = 1;", new_str: "const a = 42;" }, ctx, "build");
  assert.match(ok, /Replaced/);
  assert.match(await fs.readFile(path.join(root, "f.ts"), "utf8"), /a = 42/);
});

test("fingerprint: NestJS+Fastify+NATS+Prisma monorepo detected from evidence", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "akosua-fp-"));
  await fs.mkdir(path.join(root, "prisma"), { recursive: true });
  await fs.writeFile(path.join(root, "package.json"), JSON.stringify({
    workspaces: ["services/*"], scripts: { build: "tsc", test: "jest", lint: "eslint ." },
    dependencies: { "@nestjs/core": "^11.0.0", "@nestjs/platform-fastify": "^11.0.0", "@prisma/client": "^6.0.0", "nats": "^2.0.0" } }));
  await fs.writeFile(path.join(root, "prisma/schema.prisma"), 'datasource db { provider = "postgresql" }\nmodel User { id Int @id }');
  const fp = await fingerprintProject(root);
  assert.equal(fp.shape, "monorepo");
  assert.equal(fp.backend?.framework, "nestjs");
  assert.equal(fp.backend?.adapter, "fastify");
  assert.ok(fp.backend?.transports.includes("NATS"));
  assert.equal(fp.backend?.orm, "prisma");
  assert.match(renderProjectBrain(fp, "- a.ts — test"), /Project Brain/);
});

test("fingerprint: Flutter+Riverpod detected", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "akosua-fl-"));
  await fs.writeFile(path.join(root, "pubspec.yaml"), "name: app\ndependencies:\n  flutter_riverpod: ^2.0.0\n");
  const fp = await fingerprintProject(root);
  assert.equal(fp.mobile?.framework, "flutter");
  assert.equal(fp.mobile?.state, "riverpod");
  assert.ok(fp.verifyCommands.includes("flutter analyze"));
});

test("multi-signoff in ONE message advances through phases (live-test regression, gpt-4.1)", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "akosua-multi-"));
  const reg = new ToolRegistry(); reg.register(fileEditorTool);
  const agent = new Agent({ provider: scripted([
    { text: "Read it. UNDERSTANDING COMPLETE: tiny project. RESEARCH COMPLETE: no external APIs. PLAN COMPLETE: create b.txt" },
    { tool: { name: "file_editor", args: { command: "create", path: "b.txt", file_text: "multi" } } },
    { text: "BUILD COMPLETE: b.txt" },
    { text: "VERIFICATION COMPLETE: file written" },
  ]), model: "fake", systemPrompt: AKOSUA_SYSTEM_PROMPT, lane: "act" }, reg, root);
  for await (const _e of agent.run("do it")) { /* drain */ }
  assert.equal(await fs.readFile(path.join(root, "b.txt"), "utf8"), "multi");
});
