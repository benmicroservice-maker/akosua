import { test } from "node:test";
import assert from "node:assert/strict";
import { Agent, ToolRegistry } from "../src/index.js";
import type { ModelProvider } from "../src/providers/types.js";

const flaky = (failures: number, finalText: string): ModelProvider => {
  let calls = 0;
  return {
    id: "openai",
    async *complete() {
      calls++;
      if (calls <= failures) throw new Error("429 rate limit exceeded");
      yield { type: "text" as const, delta: finalText };
      yield { type: "done" as const, stopReason: "end" };
    },
  };
};

test("transient 429 mid-run: notice emitted, turn retried, run completes", async () => {
  const agent = new Agent(
    { provider: flaky(1, "ok\nUNDERSTANDING COMPLETE: x\nRESEARCH COMPLETE: x\nPLAN APPROVED: x\nBUILD COMPLETE: x\nVERIFICATION COMPLETE: x"), model: "m", systemPrompt: "s" },
    new ToolRegistry(), "/tmp", );
  const events: string[] = [];
  for await (const ev of agent.run("do it")) events.push(ev.type + (ev.type === "notice" ? ":" + ev.text.slice(0, 20) : ""));
  assert.ok(events.some(e => e.startsWith("notice:")), events.join(","));
  assert.equal(events.at(-1), "done");
});

test("persistent provider failure: honest phase-labelled error, not a silent done", async () => {
  const agent = new Agent(
    { provider: flaky(99, "never"), model: "m", systemPrompt: "s" },
    new ToolRegistry(), "/tmp");
  await assert.rejects(async () => { for await (const _ of agent.run("do it")) { /* drain */ } }, /Provider failed twice|Provider error/);
});
