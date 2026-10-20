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

test("OpenAI provider: gpt-6.1-sol tools 400 on chat completions falls back to /v1/responses", async () => {
  const urls: string[] = [];
  const bodies: Record<string, unknown>[] = [];
  const chatSseErr = JSON.stringify({ error: { message: "Function tools with reasoning_effort are not supported for gpt-6.1-sol in /v1/chat/completions. To use function tools, use /v1/responses or set reasoning_effort to 'none'.", type: "invalid_request_error", param: "reasoning_effort", code: null } });
  const responsesSse = [
    'data: {"type":"response.output_text.delta","delta":"Looking into it."}',
    'data: {"type":"response.output_item.done","item":{"type":"function_call","call_id":"call_1","name":"search_code","arguments":"{\\"query\\":\\"createOrder\\"}"}}',
    'data: {"type":"response.completed","response":{"output":[]}}',
    "",
  ].join("\n\n");
  const fakeFetch = async (url: string, init?: Record<string, unknown>) => {
    urls.push(String(url));
    bodies.push(JSON.parse(String((init as { body: string }).body)));
    if (String(url).endsWith("/chat/completions")) return { ok: false, status: 400, text: async () => chatSseErr, json: async () => ({}), body: undefined };
    return { ok: true, status: 200, text: async () => "", json: async () => ({}),
      body: (async function* () { yield new TextEncoder().encode(responsesSse); })() };
  };
  const secrets = { get: async () => "sk-test", set: async () => {}, delete: async () => {} };
  const provider = new OpenAIProvider(secrets as never, fakeFetch as never);
  const events: { type: string; delta?: string; call?: { name: string } }[] = [];
  for await (const e of provider.complete({
    model: "gpt-6.1-sol",
    messages: [{ role: "user", content: "find createOrder" }],
    tools: [{ name: "search_code", description: "search", parameters: { type: "object", properties: {} } }],
  })) events.push(e as never);
  assert.equal(urls.length, 2);
  assert.ok(urls[1].endsWith("/v1/responses"), `second call must be Responses API: ${urls[1]}`);
  const rbody = bodies[1] as { tools: { name?: string; function?: unknown }[]; input: unknown[] };
  assert.equal(rbody.tools[0].name, "search_code", "Responses tools are flat (name at top level)");
  assert.equal("function" in (rbody.tools[0] as object), false);
  assert.ok(events.some(e => e.type === "text" && e.delta === "Looking into it."));
  assert.ok(events.some(e => e.type === "toolCall" && e.call?.name === "search_code"));
});
