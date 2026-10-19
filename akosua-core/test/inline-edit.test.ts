import { test } from "node:test";
import assert from "node:assert/strict";
import { inlineEdit } from "../src/agent/inlineEdit.js";
import type { ModelProvider } from "../src/providers/types.js";

const scripted = (reply: string): ModelProvider => ({
  id: "openai" as const,
  async *complete() { yield { type: "text" as const, delta: reply }; yield { type: "done" as const, stopReason: "end" }; },
});

test("inline edit returns the replacement for the selection only", async () => {
  const r = await inlineEdit(scripted("const total = price * qty;"), "m", {
    filePath: "src/a.ts", language: "ts", selection: "const total = price + qty;",
    prefix: "export function f(price: number, qty: number) {", suffix: "  return total;\n}", instruction: "multiply instead of add",
  });
  assert.equal(r.replacement, "const total = price * qty;");
});

test("markdown fences are stripped", async () => {
  const r = await inlineEdit(scripted("```ts\nconst x = 2;\n```"), "m", {
    filePath: "a.ts", language: "ts", selection: "const x = 1;", prefix: "", suffix: "", instruction: "bump",
  });
  assert.equal(r.replacement, "const x = 2;");
});

test("whole-file dumps are rejected, not applied", async () => {
  const dump = Array.from({ length: 500 }, (_, i) => `line ${i}`).join("\n");
  await assert.rejects(inlineEdit(scripted(dump), "m", {
    filePath: "a.ts", language: "ts", selection: "x();", prefix: "", suffix: "", instruction: "change",
  }), /rejected/);
});
