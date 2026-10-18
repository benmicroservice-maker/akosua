import { test } from "node:test";
import assert from "node:assert/strict";
import { OpenAIProvider } from "../src/providers/openai.js";

/** Regression: GPT-6-class models on /v1/chat/completions reject function
 * tools combined with reasoning effort. The provider must pin
 * reasoning_effort:"none" whenever tools are present. */
test("OpenAI provider: reasoning_effort none when tools present, absent without tools", async () => {
  const bodies: Record<string, unknown>[] = [];
  const sse = 'data: {"choices":[{"delta":{"content":"hi"}}]}\n\ndata: [DONE]\n';
  const fakeFetch = async (_url: string, init?: Record<string, unknown>) => {
    bodies.push(JSON.parse(String((init as { body: string }).body)));
    return {
      ok: true, status: 200,
      text: async () => "",
      json: async () => ({}),
      body: (async function* () { yield new TextEncoder().encode(sse); })(),
    };
  };
  const secrets = { get: async () => "sk-test", set: async () => {}, delete: async () => {} };
  const provider = new OpenAIProvider(secrets as never, fakeFetch as never);

  for await (const _e of provider.complete({
    model: "gpt-6.1-sol",
    messages: [{ role: "user", content: "hello" }],
    tools: [{ name: "read", description: "read", parameters: { type: "object", properties: {} } }],
  })) { /* drain */ }
  assert.equal(bodies[0].reasoning_effort, "none", "tools + chat completions must pin reasoning_effort to none");

  for await (const _e of provider.complete({
    model: "gpt-6.1-sol",
    messages: [{ role: "user", content: "hello" }],
  })) { /* drain */ }
  assert.equal("reasoning_effort" in bodies[1], false, "no tools -> parameter left untouched");
});

test("OpenAI provider: max_completion_tokens default; negotiates to max_tokens when the model demands it", async () => {
  const bodies: Record<string, unknown>[] = [];
  const sse = 'data: {"choices":[{"delta":{"content":"hi"}}]}\n\ndata: [DONE]\n';
  let calls = 0;
  const fakeFetch = async (_url: string, init?: Record<string, unknown>) => {
    bodies.push(JSON.parse(String((init as { body: string }).body)));
    calls++;
    if (calls === 1) return { ok: false, status: 400,
      text: async () => JSON.stringify({ error: { message: "Unsupported parameter: 'max_completion_tokens' is not supported with this model. Use 'max_tokens' instead.", param: "max_completion_tokens", code: "unsupported_parameter" } }),
      json: async () => ({}), body: undefined };
    return { ok: true, status: 200, text: async () => "",
      json: async () => ({}),
      body: (async function* () { yield new TextEncoder().encode(sse); })() };
  };
  const secrets = { get: async () => "sk-test", set: async () => {}, delete: async () => {} };
  const provider = new OpenAIProvider(secrets as never, fakeFetch as never);
  const seen: string[] = [];
  for await (const e of provider.complete({ model: "gpt-4.1", maxTokens: 500,
    messages: [{ role: "user", content: "hello" }] })) if (e.type === "text") seen.push(e.delta);
  assert.equal(bodies[0].max_completion_tokens, 500, "default must be max_completion_tokens");
  assert.equal("max_tokens" in bodies[0], false);
  assert.equal(bodies[1].max_tokens, 500, "after 400 naming max_completion_tokens, retry must use max_tokens");
  assert.equal("max_completion_tokens" in bodies[1], false);
  assert.deepEqual(seen, ["hi"], "stream must complete after negotiation");
});
