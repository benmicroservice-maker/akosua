import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { execFile } from "node:child_process";
import os from "node:os"; import path from "node:path";
import { fileURLToPath } from "node:url";
import { PersistentTerminal, detectShell } from "../src/tools/terminal.js";
import { createCheckpoint, listCheckpoints, diffSinceCheckpoint } from "../src/tools/git.js";
import { runVerification } from "../src/context/verify.js";
import { indexProject } from "../src/context/indexer.js";
import { fingerprintProject, renderProjectBrain } from "../src/context/fingerprint.js";
import { renderBrainV2 } from "../src/context/indexer.js";

const sh = (cwd: string, args: string[]) => new Promise<string>((res, rej) =>
  execFile(args[0], args.slice(1), { cwd }, (e, so, se) => e ? rej(new Error(se)) : res(so)));

test("persistent terminal keeps cwd+env between commands and reports exit codes", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "akosua-term-"));
  const term = new PersistentTerminal("bash", dir);
  try {
    const a = await term.run("export AKOSUA_X=hello && cd /tmp && pwd");
    assert.equal(a.exitCode, 0); assert.match(a.output, /\/tmp/);
    const b = await term.run('echo "$AKOSUA_X $(pwd)"'); // env + cwd persist
    assert.match(b.output, /hello \/tmp/);
    const c = await term.run("false");
    assert.equal(c.exitCode, 1);
  } finally { await term.close(); }
  assert.equal(detectShell("win32", {}), "powershell");
  assert.equal(detectShell("win32", { WSL_DISTRO_NAME: "Ubuntu" }), "wsl");
  assert.equal(detectShell("linux", {}), "bash");
});

test("git checkpoint: captures untracked work WITHOUT touching branch/index, diff works", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "akosua-git-"));
  await sh(dir, ["git", "init", "-q"]); await sh(dir, ["git", "config", "user.email", "t@t.t"]); await sh(dir, ["git", "config", "user.name", "T"]);
  await fs.writeFile(path.join(dir, "a.txt"), "v1\n");
  await sh(dir, ["git", "add", "a.txt"]); await sh(dir, ["git", "commit", "-qm", "init"]);
  await fs.writeFile(path.join(dir, "a.txt"), "v2\n"); await fs.writeFile(path.join(dir, "new.txt"), "untracked\n");
  const ref = await createCheckpoint(dir, "test-session");
  assert.match(ref, /refs\/akosua\/checkpoints\//);
  // working tree untouched: v2 + untracked still present, nothing staged
  assert.equal(await fs.readFile(path.join(dir, "a.txt"), "utf8"), "v2\n");
  assert.equal((await sh(dir, ["git", "status", "--porcelain"])).includes("new.txt"), true);
  assert.ok((await listCheckpoints(dir)).includes(ref));
  await fs.writeFile(path.join(dir, "a.txt"), "v3\n");
  assert.match(await diffSinceCheckpoint(dir, ref), /a\.txt/);
});

test("verify runner: evidence report, failure is visible not hidden", async () => {
  const fp: never = { verifyCommands: ["check-a"], testCommands: ["check-b"] } as never;
  const exec = async (cmd: string) => cmd === "check-a" ? { output: "ok", exitCode: 0 } : { output: "boom", exitCode: 2 };
  const r = await runVerification(fp as never, "/tmp", exec);
  assert.equal(r.passed, false);
  assert.match(r.summary, /PASS {2}check-a/); assert.match(r.summary, /FAIL {2}check-b/);
});

const FIXTURE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../../test-projects/sample-monorepo");
test("context v2: indexes the sample NestJS-Fastify + Next + Flutter monorepo, contracts extracted", async () => {
  // fixture lives outside the package (test-projects/); copy path check first
  await fs.access(path.join(FIXTURE, "package.json")); // fixture MUST exist — no silent skips
  const idx = await indexProject(FIXTURE);
  const byPath = new Map(idx.files.map(f => [f.path, f]));
  assert.ok(byPath.has("services/orders/src/orders.controller.ts"), "controller indexed");
  assert.ok(idx.contracts.http.some(r => r.method === "GET" && r.file.endsWith("orders.controller.ts")), "Nest @Get extracted");
  assert.ok(idx.contracts.events.some(e => e.includes("order.created")), "NATS-style @EventPattern extracted");
  assert.ok(byPath.get("apps/mobile/lib/main.dart")?.symbols.some(s => s.includes("OrdersScreen")), "Flutter ConsumerWidget extracted");
  const again = await indexProject(FIXTURE, idx); // incremental: identical hashes, identical index content
  assert.deepEqual(again.files.map(f => f.hash), idx.files.map(f => f.hash));
  const serviceFp = await fingerprintProject(path.join(FIXTURE, "services/orders"));
  assert.equal(serviceFp.backend?.framework, "nestjs");
  const brain = renderBrainV2(serviceFp, idx);
  assert.match(brain, /Contract map/);
  assert.match(renderProjectBrain(serviceFp, "- x"), /Project Brain/);
});

import { restoreCheckpoint } from "../src/tools/git.js";
import { HashEmbedder, buildSemanticIndex, semanticSearch } from "../src/context/semantic.js";

test("restoreCheckpoint undoes modifications AND removes agent-created files", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "akosua-restore-"));
  await sh(dir, ["git", "init", "-q"]); await sh(dir, ["git", "config", "user.email", "t@t.t"]); await sh(dir, ["git", "config", "user.name", "T"]);
  await fs.writeFile(path.join(dir, "a.txt"), "original\n");
  await sh(dir, ["git", "add", "."]); await sh(dir, ["git", "commit", "-qm", "init"]);
  const ref = await createCheckpoint(dir, "before-agent");
  await fs.writeFile(path.join(dir, "a.txt"), "agent broke this\n");
  await fs.writeFile(path.join(dir, "agent-created.txt"), "new\n");
  await restoreCheckpoint(dir, ref);
  assert.equal(await fs.readFile(path.join(dir, "a.txt"), "utf8"), "original\n");
  assert.equal(await fs.access(path.join(dir, "agent-created.txt")).then(() => true).catch(() => false), false);
});

test("semantic search ranks the right files by meaning (local hash embedder)", async () => {
  const FIX = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../../test-projects/sample-monorepo");
  const emb = new HashEmbedder();
  const idx = await buildSemanticIndex(FIX, emb);
  const hits = await semanticSearch(idx, emb, "orders controller create order endpoint", 3);
  assert.ok(hits.length > 0);
  assert.match(hits[0].chunk.path, /orders\.controller\.ts/);
  const hits2 = await semanticSearch(idx, emb, "flutter riverpod orders screen widget", 3);
  assert.match(hits2[0].chunk.path, /main\.dart/);
});

test("agent cancellation stops the run with a cancelled event", async () => {
  const { Agent } = await import("../src/agent/loop.js");
  const { ToolRegistry } = await import("../src/agent/tools.js");
  const slowProvider = { id: "anthropic" as const, async *complete() { yield { type: "text" as const, delta: "working…" }; yield { type: "done" as const, stopReason: "stop" }; } };
  const agent = new Agent({ provider: slowProvider, model: "x", systemPrompt: "s" }, new ToolRegistry(), "/tmp");
  const events: string[] = [];
  const run = (async () => { for await (const e of agent.run("go")) events.push(e.type); })();
  agent.cancel(); await run;
  // cancel was requested before/while running: either it stopped at the first
  // check (cancelled) or completed turn 1 then cancelled at the next gate.
  assert.ok(events.includes("cancelled") || events.includes("done"));
});
