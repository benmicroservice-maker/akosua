import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { createCheckpoint, changedFilesSinceCheckpoint, fileDiffSinceCheckpoint, parseUnifiedDiff } from "../src/tools/git.js";

test("parseUnifiedDiff: hunks, line numbers, add/del typing", () => {
  const patch = [
    "diff --git a/src/a.ts b/src/a.ts",
    "--- a/src/a.ts", "+++ b/src/a.ts",
    "@@ -10,3 +10,4 @@ export function x() {",
    " const a = 1;",
    "-const b = 2;",
    "+const b = 3;",
    "+const c = 4;",
    " const d = 5;",
  ].join("\n");
  const [f] = parseUnifiedDiff(patch);
  assert.equal(f.file, "src/a.ts");
  assert.equal(f.hunks.length, 1);
  const adds = f.hunks[0].lines.filter(l => l.type === "add");
  const dels = f.hunks[0].lines.filter(l => l.type === "del");
  assert.deepEqual(adds.map(l => l.newLine), [11, 12]);
  assert.deepEqual(dels.map(l => l.oldLine), [11]);
});

test("change-set vs checkpoint: changed files + per-file patch parse end to end", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "akosua-diff-"));
  const g = (...a: string[]) => execFileSync("git", a, { cwd: root, encoding: "utf8" });
  g("init", "-q"); g("config", "user.email", "t@example.com"); g("config", "user.name", "T");
  fs.mkdirSync(path.join(root, "src"), { recursive: true });
  fs.writeFileSync(path.join(root, "src/a.ts"), "export const v = 1;\n");
  g("add", "."); g("commit", "-qm", "init");
  const ref = await createCheckpoint(root, "test");
  fs.writeFileSync(path.join(root, "src/a.ts"), "export const v = 2;\nexport const w = 3;\n");
  fs.writeFileSync(path.join(root, "src/b.ts"), "export const n = 1;\n");
  const changed = await changedFilesSinceCheckpoint(root, ref);
  assert.ok(changed.some(c => c.path === "src/a.ts"), JSON.stringify(changed));
  const patch = await fileDiffSinceCheckpoint(root, ref, "src/a.ts");
  const [f] = parseUnifiedDiff(patch);
  assert.equal(f.file, "src/a.ts");
  assert.ok(f.hunks[0].lines.some(l => l.type === "add" && l.text.includes("w = 3")));
});
