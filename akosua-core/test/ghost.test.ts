import { test } from "node:test";
import assert from "node:assert/strict";
import { ghostComplete } from "../src/agent/complete.js";
import type { ModelProvider } from "../src/providers/types.js";

const scripted = (reply: string): ModelProvider => ({
  id: "openai",
  async *complete() { yield { type: "text" as const, delta: reply }; yield { type: "done" as const, stopReason: "end" }; },
});

test("ghost completion returns the short continuation", async () => {
  const out = await ghostComplete(scripted("total * qty;"), "m", {
    filePath: "a.ts", language: "ts", prefix: "const price = ", suffix: "\nreturn price;",
  });
  assert.equal(out, "total * qty;");
});

test("speeches are refused (empty = no ghost text shown)", async () => {
  const speech = Array.from({ length: 40 }, (_, i) => `line ${i}`).join("\n");
  const out = await ghostComplete(scripted(speech), "m", { filePath: "a.ts", language: "ts", prefix: "x", suffix: "" });
  assert.equal(out, "");
});
