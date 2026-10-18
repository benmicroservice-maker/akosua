import { test } from "node:test";
import assert from "node:assert/strict";
import { createDelegateBatchTool } from "../src/agent/delegate.js";
import type { ModelProvider } from "../src/providers/types.js";
import type { Tool } from "../src/agent/tools.js";

const docs: Tool = { definition: { name: "context7_docs", description: "d", parameters: { type: "object", properties: {} } }, phases: ["research"], run: async () => "docs evidence" };

test("batch: questions fan out, digests labelled, cap of 4 enforced", async () => {
  let concurrent = 0, maxConcurrent = 0;
  const provider: ModelProvider = {
    id: "openai",
    async *complete() {
      concurrent++; maxConcurrent = Math.max(maxConcurrent, concurrent);
      await new Promise(r => setTimeout(r, 25));
      concurrent--;
      yield { type: "text" as const, delta: "DIGEST: finding." };
      yield { type: "done" as const, stopReason: "end" };
    },
  };
  const tool = createDelegateBatchTool({ provider, model: "m", tools: [docs], workspaceRoot: "/tmp" });
  const out = await tool.run({ questions: ["q1", "q2", "q3", "q4", "q5-overflow"] }, { workspaceRoot: "/tmp" } as never, "research");
  assert.match(out, /Q1: q1/); assert.match(out, /Q4: q4/);
  assert.ok(!out.includes("q5-overflow"));
  assert.ok(maxConcurrent >= 3, `expected parallelism, saw ${maxConcurrent}`);
});
