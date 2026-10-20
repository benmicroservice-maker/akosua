import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { planFormatting, runFormatting } from "../src/context/format.js";

function dir(files: Record<string, string>): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "akosua-fmt-"));
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(d, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }
  return d;
}

test("prettier planned only when the project declares it", async () => {
  const withDep = dir({ "package.json": JSON.stringify({ devDependencies: { prettier: "^3.0.0" } }), "src/a.ts": "const x=1" });
  const plans = await planFormatting(withDep, ["src/a.ts"]);
  assert.equal(plans.length, 1); assert.equal(plans[0].label, "Prettier");

  const without = dir({ "package.json": JSON.stringify({ dependencies: {} }), "src/a.ts": "const x=1" });
  assert.deepEqual(await planFormatting(without, ["src/a.ts"]), []);
});

test("dart + ruff planning follow their own declarations", async () => {
  const d = dir({ "pubspec.yaml": "name: app\n", "lib/main.dart": "void main(){}", "pyproject.toml": "[tool.ruff]\nline-length=100\n", "tool.py": "x=1\n" });
  const labels = (await planFormatting(d, ["lib/main.dart", "tool.py"])).map(p => p.label).sort();
  assert.deepEqual(labels, ["dart format", "ruff format"]);
});

test("no declarations -> no commands, empty evidence (never guess style)", async () => {
  const d = dir({ "src/a.ts": "const x=1" });
  assert.equal(await runFormatting(d, ["src/a.ts"]), "");
});
