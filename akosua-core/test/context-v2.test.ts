import { test } from "node:test";
import assert from "node:assert/strict";
import { compactHistory, contextPressure, effectiveBudget, shapeToolResultFor, historyTokens } from "../src/agent/context.js";
import type { ChatMessage } from "../src/providers/types.js";

const big = (n: number, tag: string) => Array.from({ length: n }, (_, i) => `${tag} line ${i} ${"x".repeat(40)}`).join("\n");

test("contextPressure stages at 70/80/90%", () => {
  assert.equal(contextPressure(50, 100), "ok");
  assert.equal(contextPressure(75, 100), "warn");
  assert.equal(contextPressure(85, 100), "mask");
  assert.equal(contextPressure(95, 100), "prune");
});

test("effectiveBudget budgets to a fraction of the rated window", () => {
  assert.equal(effectiveBudget(200_000), 150_000);
  assert.equal(effectiveBudget(128_000, 0.5), 64_000);
});

test("shapeToolResultFor: per-tool caps (terminal earns more than default)", () => {
  const huge = big(2000, "out"); // ~90k chars
  const term = shapeToolResultFor("terminal", huge);
  const other = shapeToolResultFor("some_lookup", huge);
  assert.ok(term.length > other.length, "terminal cap should exceed default cap");
  assert.ok(term.length <= 12_000 * 1.5 + 100);
  assert.match(term, /elided/);
});

test("compactHistory: staged — decisions + recent evidence survive, bulk digests", () => {
  const msgs: ChatMessage[] = [{ role: "system", content: "sys" }, { role: "user", content: "do the task" }];
  for (let i = 0; i < 20; i++) msgs.push({ role: "tool", content: big(120, `old${i}`), name: "terminal", toolCallId: `t${i}` });
  msgs.push({ role: "assistant", content: "DECISION: use approach X because Y" });
  for (let i = 0; i < 4; i++) msgs.push({ role: "tool", content: big(120, `recent${i}`), name: "terminal", toolCallId: `r${i}` });
  const before = historyTokens(msgs);
  const rep = compactHistory(msgs, 4000);
  assert.ok(rep.tokensAfter < before, "compaction must shrink history");
  assert.equal(rep.pressure, "prune");
  assert.ok(msgs.some(m => m.content?.includes("DECISION: use approach X")), "assistant decisions preserved");
  assert.ok(msgs.some(m => m.content?.startsWith("[earlier terminal")), "old evidence digested");
  assert.ok(msgs.some(m => m.content?.includes("recent3 line")), "recent evidence verbatim");
});

test("compactHistory: short histories are never touched", () => {
  const msgs: ChatMessage[] = [{ role: "user", content: "hi" }, { role: "tool", content: big(10, "small"), name: "terminal", toolCallId: "t" }];
  const rep = compactHistory(msgs, 100);
  assert.equal(rep.digested + rep.truncated, 0);
});
