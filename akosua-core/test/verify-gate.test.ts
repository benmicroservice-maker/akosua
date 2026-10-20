import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os"; import path from "node:path";
import { Agent } from "../src/agent/loop.js";
import { ToolRegistry, type Tool } from "../src/agent/tools.js";
import type { ModelProvider } from "../src/providers/types.js";

test("verify gate: VERIFICATION sign-off is rejected until run_verification actually runs", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "akosua-vgate-"));
  let verifyRuns = 0;
  const verifyTool: Tool = {
    definition: { name: "run_verification", description: "run checks", parameters: { type: "object", properties: {} } },
    phases: ["verify"],
    run: async () => { verifyRuns++; return "Verify evidence: 1 passed, 0 failed (mock)"; },
  };
  const registry = new ToolRegistry(); registry.register(verifyTool);
  const turns: Array<{ text?: string; tool?: string }> = [
    { text: "UNDERSTANDING COMPLETE: x" }, { text: "RESEARCH COMPLETE: x" }, { text: "PLAN COMPLETE: x" },
    { text: "BUILD COMPLETE: x" },
    { text: "VERIFICATION COMPLETE: trust me, it works" },
    { tool: "run_verification" },
    { text: "VERIFICATION COMPLETE: 1 passed, 0 failed (evidence above)" },
  ];
  let i = 0;
  const provider: ModelProvider = { id: "anthropic", async *complete() {
    const turn = turns[Math.min(i++, turns.length - 1)];
    if (turn.text) yield { type: "text", delta: turn.text };
    if (turn.tool) yield { type: "toolCall", call: { id: "c" + i, name: turn.tool, arguments: "{}" } };
    yield { type: "done", stopReason: "stop" };
  } };
  const agent = new Agent({ provider, model: "m", systemPrompt: "test" }, registry, root);
  let done = "";
  for await (const e of agent.run("task")) if (e.type === "done") done = e.phase;
  assert.equal(done, "verify");
  assert.equal(verifyRuns, 1, "verification tool must actually execute exactly once");
  assert.ok(agent.history.some(m => m.content.includes("VERIFICATION REJECTED")), "first sign-off must be blocked with the reason fed back");
});
