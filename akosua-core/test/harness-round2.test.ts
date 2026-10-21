import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Agent } from "../src/agent/loop.js";
import { ToolRegistry } from "../src/agent/tools.js";
import { classifyIntent, actKindOf } from "../src/agent/intent.js";
import type { ModelProvider } from "../src/providers/types.js";

/** ROUND 2 — regressions from the user's live screenshots (2026-10-20):
 * "start the app" never ran anything: plan gate stranded it, research
 * ceremony ate the run, reads rendered as edits. These pin the fixes. */

interface Script { text?: string; tool?: { name: string; args: Record<string, unknown> } }
function scripted(steps: Script[], counter = { calls: 0, toolsOffered: [] as string[][] }): ModelProvider {
  let i = 0;
  return { id: "openai", async *complete(req) {
    counter.calls++;
    counter.toolsOffered.push((req.tools ?? []).map(t => t.name));
    const s = steps[Math.min(i++, steps.length - 1)] ?? {};
    if (s.text) yield { type: "text", delta: s.text };
    if (s.tool) yield { type: "toolCall", call: { id: `c${i}`, name: s.tool.name, arguments: JSON.stringify(s.tool.args) } };
    yield { type: "done", stopReason: "stop" };
  } };
}

test("R2 classifier: awareness/overview is ask, 'start the app' is act/execute", () => {
  assert.equal(classifyIntent("get context awareness of this porjec").lane, "ask");
  assert.equal(classifyIntent("give me an overview of this codebase").lane, "ask");
  assert.equal(classifyIntent("walk me through the order flow").lane, "ask");
  const start = classifyIntent("start the app");
  assert.equal(start.lane, "act");
  assert.equal(actKindOf("start the app", start.lane), "execute");
  // overview + real action verb still acts
  assert.equal(classifyIntent("give me an overview then fix the login bug").lane, "act");
});

test("R2 EVAL execute: 'start the app' reaches the terminal with plan gate ON, no approval, no research tools", async () => {
  const c = { calls: 0, toolsOffered: [] as string[][] };
  const registry = new ToolRegistry();
  let terminalRuns = 0;
  registry.register({ definition: { name: "context7_docs", description: "docs", parameters: { type: "object", properties: {} } }, phases: ["research", "understand"], run: async () => "docs" });
  registry.register({ definition: { name: "list_files", description: "ls", parameters: { type: "object", properties: {} } }, phases: ["understand", "plan"], run: async () => "package.json" });
  registry.register({ definition: { name: "terminal", description: "run", parameters: { type: "object", properties: {} } }, phases: ["build", "verify"], run: async () => { terminalRuns++; return "Metro waiting on http://localhost:8081"; } });
  const agent = new Agent({ provider: scripted([
    { text: "UNDERSTANDING COMPLETE: npm start = expo start. RESEARCH COMPLETE: skipped. PLAN COMPLETE: npm run start" },
    { tool: { name: "terminal", args: { command: "npm run start" } } },
    { text: "BUILD COMPLETE: server launched" },
    { tool: { name: "terminal", args: { command: "curl -s http://localhost:8081" } } },
    { text: "VERIFICATION COMPLETE: server responded; startup output shown above" },
  ], c), model: "m", systemPrompt: "s", requirePlanApproval: true }, registry, "/tmp");
  const phases: string[] = [];
  for await (const e of agent.run("start the app")) if (e.type === "phase") phases.push(e.phase);
  assert.equal(terminalRuns, 2, "terminal actually ran (build launch + verify probe)");
  assert.ok(!c.toolsOffered.flat().includes("context7_docs"), "research tools never offered to execute runs");
  assert.ok(c.calls <= 6, `BUDGET: execute completed in ${c.calls} calls (max 6)`);
  assert.ok(!phases.includes("research"), "research phase skipped, not visited");
});

test("R2 tool events: file_editor reads carry action=view (UI Read/Edit label source)", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "akosua-r2-"));
  await fs.writeFile(path.join(root, "a.txt"), "hello");
  const { fileEditorTool } = await import("../src/tools/fileEditor.js");
  const registry = new ToolRegistry(); registry.register(fileEditorTool);
  const agent = new Agent({ provider: scripted([
    { tool: { name: "file_editor", args: { command: "view", path: "a.txt" } } },
    { text: "It says hello." },
  ]), model: "m", systemPrompt: "s" }, registry, root);
  const actions: (string | undefined)[] = [];
  for await (const e of agent.run("what does a.txt say?")) if (e.type === "tool") actions.push(e.action);
  assert.deepEqual(actions, ["view"]);
});
