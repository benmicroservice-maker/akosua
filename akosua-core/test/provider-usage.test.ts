import { test } from "node:test";
import assert from "node:assert/strict";
import { AnthropicProvider } from "../src/providers/anthropic.js";
import { OpenAIProvider } from "../src/providers/openai.js";
import type { FetchLike, StreamEvent } from "../src/providers/types.js";

const sse = (lines: string[]): AsyncIterable<Uint8Array> => (async function* () {
  yield new TextEncoder().encode(lines.map(l => `data: ${l}\n`).join(""));
})();
const secrets = { get: async () => "sk-test", set: async () => {}, delete: async () => {} } as never;

test("anthropic stream: done carries usage + response model", async () => {
  const fetchFn: FetchLike = async () => ({
    ok: true, status: 200, text: async () => "", json: async () => ({}),
    body: sse([
      JSON.stringify({ type: "message_start", message: { model: "claude-x-1", usage: { input_tokens: 1200, cache_read_input_tokens: 300, output_tokens: 1 } } }),
      JSON.stringify({ type: "content_block_delta", delta: { type: "text_delta", text: "hi" } }),
      JSON.stringify({ type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 42 } }),
    ]),
  });
  const p = new AnthropicProvider(secrets, fetchFn as never);
  const evs: StreamEvent[] = [];
  for await (const ev of p.complete({ model: "claude-x", messages: [{ role: "user", content: "hi" }] })) evs.push(ev);
  const done = evs.find(e => e.type === "done") as Extract<StreamEvent, { type: "done" }>;
  assert.equal(done.stopReason, "tool_use");
  assert.equal(done.responseModel, "claude-x-1");
  assert.deepEqual(done.usage, { inputTokens: 1200, cachedInputTokens: 300, outputTokens: 42 });
});

test("openai responses stream: done carries usage + model", async () => {
  let calls = 0;
  const fetchFn: FetchLike = async (url: string) => {
    calls++;
    if (String(url).includes("/chat/completions")) {
      // GPT-6-class rejection that triggers the transparent Responses switch.
      return { ok: false, status: 400, text: async () => "Function tools with reasoning_effort are not supported", json: async () => ({}), body: undefined };
    }
    return {
      ok: true, status: 200, text: async () => "", json: async () => ({}),
      body: sse([
        JSON.stringify({ type: "response.output_text.delta", delta: "hi" }),
        JSON.stringify({ type: "response.completed", response: { status: "completed", model: "gpt-x-2026", usage: { input_tokens: 500, output_tokens: 60, input_tokens_details: { cached_tokens: 128 } }, output: [] } }),
      ]),
    };
  };
  const p = new OpenAIProvider(secrets, fetchFn as never);
  // Force the Responses path the same way production does: tools present.
  const evs: StreamEvent[] = [];
  for await (const ev of p.complete({ model: "gpt-x", messages: [{ role: "user", content: "hi" }], tools: [{ name: "t", description: "t", parameters: { type: "object", properties: {} } }] })) evs.push(ev);
  const done = evs.find(e => e.type === "done") as Extract<StreamEvent, { type: "done" }>;
  assert.ok(done, `expected a done event, got ${evs.map(e => e.type).join(",")}`);
  assert.equal(done.responseModel, "gpt-x-2026");
  assert.deepEqual(done.usage, { inputTokens: 500, outputTokens: 60, cachedInputTokens: 128 });
});
