import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileEditorTool } from "../src/tools/fileEditor.js";

const ctx = (root: string) => ({ workspaceRoot: root } as never);
const run = (a: Record<string, unknown>, root: string, phase = "build") =>
  fileEditorTool.run(a, ctx(root), phase as never);

function ws(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "akosua-safe-"));
  const root = path.join(dir, "ws");
  fs.mkdirSync(path.join(root, "src"), { recursive: true });
  fs.writeFileSync(path.join(root, "src", "a.ts"), "export const a = 1;\n");
  fs.writeFileSync(path.join(root, ".env"), "OPENAI_API_KEY=[SECURITY_DATA]");
  fs.writeFileSync(path.join(root, ".env.example"), "OPENAI_API_KEY=\n");
  fs.writeFileSync(path.join(root, "package-lock.json"), "{}\n");
  return root;
}

test("traversal and sibling-prefix escapes are refused", async () => {
  const root = ws();
  assert.match(await run({ command: "view", path: "../outside.txt" }, root, "understand"), /escapes workspace/);
  assert.match(await run({ command: "create", path: "../ws-evil/x.txt", file_text: "x" }, root), /escapes workspace/);
  assert.equal(fs.existsSync(path.join(path.dirname(root), "ws-evil")), false);
});

test("symlink escape is refused on read and write", async (t) => {
  const root = ws();
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "akosua-out-"));
  fs.writeFileSync(path.join(outside, "secret.txt"), "host-secret\n");
  try { fs.symlinkSync(outside, path.join(root, "linked"), "dir"); }
  catch { t.skip("symlinks unavailable on this platform"); return; }
  const read = await run({ command: "view", path: "linked/secret.txt" }, root, "understand").catch((e: Error) => `Error: ${e.message}`);
  assert.match(String(read), /escapes workspace|symlink/i);
  assert.doesNotMatch(String(read), /host-secret/);
  const write = await run({ command: "create", path: "linked/pwned.txt", file_text: "x" }, root).catch((e: Error) => `Error: ${e.message}`);
  assert.match(String(write), /escapes workspace|symlink/i);
  assert.equal(fs.existsSync(path.join(outside, "pwned.txt")), false);
});

test("secrets and VCS internals are not readable by the agent", async () => {
  const root = ws();
  const env = await run({ command: "view", path: ".env" }, root, "understand");
  assert.match(env, /protected/i);
  assert.doesNotMatch(env, /sk-test-123/);
  const example = await run({ command: "view", path: ".env.example" }, root, "understand");
  assert.match(example, /OPENAI_API_KEY=/);
  const git = await run({ command: "view", path: ".git/config" }, root, "understand").catch((e: Error) => `Error: ${e.message}`);
  assert.match(String(git), /protected/i);
});

test("lockfiles and .akosua state are not writable via file_editor", async () => {
  const root = ws();
  const lock = await run({ command: "str_replace", path: "package-lock.json", old_str: "{}", new_str: "{\"x\":1}" }, root);
  assert.match(lock, /protected|not writable/i);
  assert.equal(fs.readFileSync(path.join(root, "package-lock.json"), "utf8"), "{}\n");
  const state = await run({ command: "create", path: ".akosua/notes.md", file_text: "x" }, root);
  assert.match(state, /protected|not writable/i);
});

test("normal workspace operations still work", async () => {
  const root = ws();
  assert.match(await run({ command: "view", path: "src/a.ts" }, root, "understand"), /export const a/);
  assert.match(await run({ command: "create", path: "src/b.ts", file_text: "export const b = 2;\n" }, root), /Created/);
});
