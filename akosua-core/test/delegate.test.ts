import { test } from "node:test";
import assert from "node:assert/strict";
import { createDelegateResearchTool } from "../src/agent/delegate.js";
import type { ModelProvider } from "../src/providers/types.js";
import type { Tool } from "../src/agent/tools.js";

const fakeDocs: Tool = {
  definition: { name: "context7_docs", description: "docs", parameters: { type: "object", properties: {} } },
  phases: ["research"],
  run: async () => "NATS JetStream durable consumers: use stream + durable name; ack explicit. (docs: jetstream v2.10)",
};

test("delegate_research: sub-agent tools run, digest extracted and capped", async () => {
  let turn = 0;
  const provider: ModelProvider = {
    id: "openai",
    async *complete(req) {
      turn++;
      if (turn === 1) {
        yield { type: "toolCall" as const, call: { id: "1", name: "context7_docs", arguments: JSON.stringify({ library: "nats" }) } };
        yield { type: "done" as const, stopReason: "tool" };
      } else {
        // verify the tool result actually reached the sub-agent
        const flat = JSON.stringify(req.messages);
        assert.match(flat, /durable consumers/);
        yield { type: "text" as const, delta: "DIGEST: Use durable consumers with explicit ack. Sources: jetstream docs." };
        yield { type: "done" as const, stopReason: "end" };
      }
    },
  };
  const tool = createDelegateResearchTool({ provider, model: "m", tools: [fakeDocs], workspaceRoot: "/tmp" });
  const out = await tool.run({ question: "How do JetStream durable consumers work?" }, { workspaceRoot: "/tmp" } as never, "research");
  assert.match(out, /SUB-AGENT DIGEST/);
  assert.match(out, /durable consumers/);
  assert.ok(turn >= 2);
});

test("delegate has no edit tools by construction and rejects empty questions", async () => {
  const tool = createDelegateResearchTool({ provider: { id: "openai", async *complete() { yield { type: "done" as const, stopReason: "end" }; } }, model: "m", tools: [fakeDocs], workspaceRoot: "/tmp" });
  assert.match(await tool.run({ question: "  " }, { workspaceRoot: "/tmp" } as never, "research"), /Error/);
});

test("delegate_research: flight tap sees sub-agent internals, not just the digest", async () => {
  const events: { type: string; data: Record<string, unknown> }[] = [];
  const flight = { record: (type: string, data: Record<string, unknown> = {}) => { events.push({ type, data }); } };
  let turn = 0;
  const provider: ModelProvider = {
    id: "openai",
    async *complete() {
      turn++;
      if (turn === 1) {
        yield { type: "toolCall" as const, call: { id: "1", name: "context7_docs", arguments: JSON.stringify({ library: "nats" }) } };
        yield { type: "done" as const, stopReason: "tool_use", usage: { inputTokens: 900, outputTokens: 40 } };
      } else {
        yield { type: "text" as const, delta: "DIGEST: durable consumers, explicit ack." };
        yield { type: "done" as const, stopReason: "stop", usage: { inputTokens: 1500, outputTokens: 60 } };
      }
    },
  };
  const tool = createDelegateResearchTool({ provider, model: "m", tools: [fakeDocs], workspaceRoot: "/tmp", flight });
  const out = await tool.run({ question: "JetStream durable consumers?" }, { workspaceRoot: "/tmp" } as never, "research");
  assert.match(out, /SUB-AGENT DIGEST/);
  const types = events.map(e => e.type);
  for (const want of ["subagent.start", "subagent.model", "subagent.tool", "subagent.end"])
    assert.ok(types.includes(want), `missing ${want}; got ${types.join(",")}`);
  const subId = String(events[0].data.subagent);
  assert.ok(subId.startsWith("sub-"));
  assert.ok(events.every(e => e.data.subagent === subId), "all sub events share the subagent id");
  const model = events.find(e => e.type === "subagent.model")!;
  assert.deepEqual(model.data.usage, { inputTokens: 900, outputTokens: 40 });
  const toolEv = events.find(e => e.type === "subagent.tool")!;
  assert.equal(toolEv.data.name, "context7_docs");
});
