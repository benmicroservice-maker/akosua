import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os"; import path from "node:path";
import { fileURLToPath } from "node:url";
import { runVerification } from "../src/context/verify.js";
import { fingerprintProject } from "../src/context/fingerprint.js";
import { fileEditorTool } from "../src/tools/fileEditor.js";
import { terminalTool } from "../src/tools/terminal.js";
import { ToolRegistry } from "../src/agent/tools.js";

test("AUDIT: verification with NO detected commands is COULD-NOT-RUN, never PASSED", async () => {
  const fp = { verifyCommands: [], testCommands: [] } as never;
  const r = await runVerification(fp as never, "/tmp", async () => ({ output: "", exitCode: 0 }));
  assert.equal(r.passed, false);
  assert.match(r.summary, /COULD NOT RUN/);
});

test("AUDIT: file_editor cannot escape into a sibling folder sharing the root prefix", async () => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "akosua-esc-"));
  const ws = path.join(base, "ws"); const evil = path.join(base, "ws-evil");
  await fs.mkdir(ws); await fs.mkdir(evil);
  await fs.writeFile(path.join(evil, "secret.txt"), "do not touch");
  await assert.rejects(
    fileEditorTool.run({ command: "view", path: "../ws-evil/secret.txt" }, { workspaceRoot: ws }, "understand"),
    /escapes workspace/);
});

test("AUDIT: terminal tool is NOT available before Build (phase gate cannot be bypassed with a shell)", async () => {
  assert.deepEqual(terminalTool().phases, ["build", "verify"]);
  const reg = new ToolRegistry(); reg.register(terminalTool(new Map()));
  const out = await reg.run("terminal", { command: "echo hi" }, { workspaceRoot: "/tmp" }, "understand");
  assert.match(out, /NOT available in the "understand" phase/);
});

test("AUDIT: fingerprint finds nested monorepo manifests (Flutter in apps/*, Nest service in services/*)", async () => {
  const FIXTURE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../../test-projects/sample-monorepo");
  const fp = await fingerprintProject(FIXTURE);
  assert.equal(fp.backend?.framework, "nestjs");
  assert.equal(fp.mobile?.framework, "flutter", "nested pubspec must be found");
  assert.equal(fp.mobile?.state, "riverpod");
  assert.equal(fp.flutterDir?.replace(/\\/g, "/"), "apps/mobile");
  assert.ok(fp.verifyCommands.some(c => c.includes("flutter analyze apps/mobile")), `verify must target the flutter app dir, got: ${fp.verifyCommands}`);
});

test("AUDIT: AKOSUA_RULES.md + personal rules reach the agent system prompt", async () => {
  const { buildAkosuaAgent } = await import("../src/agent/assemble.js");
  const { InMemorySecretStore } = await import("../src/secrets.js");
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "akosua-rules-"));
  await fs.writeFile(path.join(dir, "package.json"), JSON.stringify({ name: "x" }));
  await fs.writeFile(path.join(dir, "AKOSUA_RULES.md"), "Always use Fastify adapter, never Express.");
  const provider = { id: "anthropic" as const, async *complete() { yield { type: "done" as const, stopReason: "stop" }; } };
  const bundle = await buildAkosuaAgent({
    secrets: new InMemorySecretStore(), provider, model: "fake", workspaceRoot: dir,
    extraInstructions: "Prefer Riverpod Notifier over StateNotifier.",
  });
  const sys = bundle.agent.history[0].content;
  assert.match(sys, /Always use Fastify adapter/);
  assert.match(sys, /Prefer Riverpod Notifier/);
  await bundle.close();
});
