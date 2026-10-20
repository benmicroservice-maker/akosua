import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { findReplaceRange, fileEditorTool } from "../src/tools/fileEditor.js";

test("exact match wins; duplicates are an error, not a guess", () => {
  const c = "a\nconst x = 1;\nb\nconst x = 1;\n";
  const r = findReplaceRange(c, "const x = 1;");
  assert.ok("error" in r);
  const ok = findReplaceRange("a\nconst x = 1;\nb\n", "const x = 1;");
  assert.ok(!("error" in ok) && ok.tier === "exact");
});

test("whitespace drift: indentation + trailing spaces still land the edit", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "akosua-ed-"));
  const file = path.join(dir, "a.ts");
  fs.writeFileSync(file, "export function f() {\n    const total = 1;   \n    return total;\n}\n");
  const res = await fileEditorTool.run(
    { command: "str_replace", path: "a.ts", old_str: "const total = 1;\nreturn total;", new_str: "const total = 2;\nreturn total;" },
    { workspaceRoot: dir } as never, "build");
  assert.match(res, /whitespace tolerance/);
  assert.match(fs.readFileSync(file, "utf8"), /const total = 2;/);
});

test("ambiguous whitespace match refuses", () => {
  const r = findReplaceRange("  x();\n  x();\n", "x();");
  assert.ok("error" in r);
});

test("genuinely missing text reports both tiers tried", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "akosua-ed-"));
  fs.writeFileSync(path.join(dir, "a.ts"), "const a = 1;\n");
  const res = await fileEditorTool.run(
    { command: "str_replace", path: "a.ts", old_str: "const zzz = 9;", new_str: "const zzz = 10;" },
    { workspaceRoot: dir } as never, "build");
  assert.match(res, /not found/);
});
