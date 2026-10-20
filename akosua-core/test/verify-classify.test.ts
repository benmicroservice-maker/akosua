import { test } from "node:test";
import assert from "node:assert/strict";
import { classify, runVerification } from "../src/context/verify.js";
import type { StackFingerprint } from "../src/context/fingerprint.js";

const fp = (verifyCommands: string[]): StackFingerprint => ({ root: "/tmp", shape: "unknown", testCommands: [], verifyCommands } as StackFingerprint);

test("classify: pass/fail/missing-tooling distinguished", () => {
  assert.equal(classify({ command: "x", exitCode: 0, output: "" }), "PASS");
  assert.equal(classify({ command: "x", exitCode: 1, output: "error TS2322" }), "FAIL");
  assert.equal(classify({ command: "flutter analyze", exitCode: 127, output: "" }), "COULD-NOT-RUN");
  assert.equal(classify({ command: "x", exitCode: 1, output: "'ruff' is not recognized as an internal or external command" }), "COULD-NOT-RUN");
});

test("missing tooling is reported as COULD-NOT-RUN, never as a code FAIL", async () => {
  const r = await runVerification(fp(["missing-tool --check"]), "/tmp", async () => ({ output: "missing-tool: command not found", exitCode: 127 }));
  assert.match(r.summary, /COULD-NOT-RUN/);
  assert.equal(r.passed, false);
});

test("hung command times out and is classified TIMEOUT", async () => {
  const r = await runVerification(fp(["sleep forever"]), "/tmp",
    () => new Promise(res => { const h = setTimeout(() => res({ output: "late", exitCode: 0 }), 60_000); (h as unknown as { unref?: () => void }).unref?.(); }), 6000, 60);
  assert.match(r.summary, /TIMEOUT/);
  assert.equal(r.results[0].exitCode, 124);
});
