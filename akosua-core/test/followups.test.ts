import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { createGitCheckpointTool, ensureAkosuaStateIgnored, listCheckpoints } from "../src/tools/git.js";
import { AKOSUA_SYSTEM_PROMPT } from "../src/agent/loop.js";

const sh = (cwd: string, args: string[]) => new Promise<string>((res, rej) =>
  execFile(args[0], args.slice(1), { cwd }, (e, so, se) => e ? rej(new Error(se)) : res(so)));

async function gitRepo(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "akosua-followup-"));
  await sh(dir, ["git", "init", "-q"]);
  await sh(dir, ["git", "config", "user.email", "t@t.t"]);
  await sh(dir, ["git", "config", "user.name", "T"]);
  await fs.writeFile(path.join(dir, "a.txt"), "hello\n");
  await sh(dir, ["git", "add", "."]);
  await sh(dir, ["git", "commit", "-qm", "init"]);
  return dir;
}

test("git_checkpoint tool: one checkpoint per session, repeats reuse the ref", async () => {
  const dir = await gitRepo();
  const tool = createGitCheckpointTool();
  const ctx = { workspaceRoot: dir };
  const first = await tool.run({ label: "build start" }, ctx, "build");
  assert.match(first, /Checkpoint created: refs\/akosua\/checkpoints\//);
  const second = await tool.run({ label: "before edit 2" }, ctx, "build");
  assert.match(second, /already created for this agent session/);
  assert.equal((await listCheckpoints(dir)).length, 1, "exactly one checkpoint ref must exist");
});

test("ensureAkosuaStateIgnored: adds .akosua/ once, only in git repos", async () => {
  const dir = await gitRepo();
  await ensureAkosuaStateIgnored(dir);
  await ensureAkosuaStateIgnored(dir); // idempotent
  const ignore = await fs.readFile(path.join(dir, ".gitignore"), "utf8");
  assert.equal(ignore.split("\n").filter(l => l.trim() === ".akosua/").length, 1);
  // a .akosua folder must not show up in git status
  await fs.mkdir(path.join(dir, ".akosua"));
  await fs.writeFile(path.join(dir, ".akosua", "research-cache.json"), "{}");
  const status = await sh(dir, ["git", "status", "--porcelain"]);
  assert.ok(!status.includes(".akosua"), "state folder must be git-ignored");
  // non-git folder: no .gitignore created
  const plain = await fs.mkdtemp(path.join(os.tmpdir(), "akosua-plain-"));
  await ensureAkosuaStateIgnored(plain);
  await assert.rejects(fs.stat(path.join(plain, ".gitignore")));
});

test("system prompt forbids claiming success when verification could not run", () => {
  assert.match(AKOSUA_SYSTEM_PROMPT, /COULD NOT RUN/);
  assert.match(AKOSUA_SYSTEM_PROMPT, /correctness is UNKNOWN/);
  assert.match(AKOSUA_SYSTEM_PROMPT, /never write "no errors detected"/i);
});
