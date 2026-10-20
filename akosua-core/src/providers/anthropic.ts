import type { SecretStore } from "../secrets.js";
import { SecretKeys } from "../secrets.js";
import type { CompletionRequest, FetchLike, ModelProvider, StreamEvent } from "./types.js";

export class AnthropicProvider implements ModelProvider {
  readonly id = "anthropic" as const;
  constructor(private secrets: SecretStore, private fetchFn: FetchLike = fetch as never) {}
  async *complete(req: CompletionRequest): AsyncIterable<StreamEvent> {
    const key = await this.secrets.get(SecretKeys.anthropic);
    if (!key) throw new Error("Anthropic API key not set (Settings -> Providers & Keys)");
    const system = req.messages.filter(m => m.role === "system").map(m => m.content).join("\n");
    const messages = req.messages.filter(m => m.role !== "system").map(m => ({
      role: m.role === "tool" ? "user" : m.role,
      content: m.role === "tool"
        ? [{ type: "tool_result", tool_use_id: m.toolCallId, content: m.content }]
        : m.toolCalls?.length
          ? [...(m.content ? [{ type: "text", text: m.content }] : []),
             ...m.toolCalls.map(tc => ({ type: "tool_use", id: tc.id, name: tc.name, input: safeParse(tc.arguments) }))]
          : m.content,
    }));
    const res = await this.fetchFn("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({ model: req.model, system: system || undefined, messages,
        max_tokens: req.maxTokens ?? 8192, temperature: req.temperature,
        tools: req.tools?.map(t => ({ name: t.name, description: t.description, input_schema: t.parameters })),
        stream: true }),
    });
    if (!res.ok) throw new Error(`Anthropic ${res.status}: ${await res.text()}`);
    yield* parseAnthropicStream(res.body!);
  }
}
function safeParse(s: string): unknown { try { return JSON.parse(s); } catch { return {}; } }
async function* parseAnthropicStream(body: AsyncIterable<Uint8Array>): AsyncIterable<StreamEvent> {
  const dec = new TextDecoder(); let buf = "";
  const partial: Record<number, { id: string; name: string; json: string }> = {};
  let usage: { inputTokens?: number; outputTokens?: number; cachedInputTokens?: number } = {};
  let responseModel: string | undefined;
  for await (const chunk of body) {
    buf += dec.decode(chunk, { stream: true });
    let i: number;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
      if (!line.startsWith("data:")) continue;
      const data = line.slice(5).trim(); if (data === "[DONE]") continue;
      let ev: any; try { ev = JSON.parse(data); } catch { continue; }
      if (ev.type === "content_block_delta" && ev.delta?.type === "text_delta") yield { type: "text", delta: ev.delta.text };
      if (ev.type === "content_block_start" && ev.content_block?.type === "tool_use")
        partial[ev.index] = { id: ev.content_block.id, name: ev.content_block.name, json: "" };
      if (ev.type === "content_block_delta" && ev.delta?.type === "input_json_delta") partial[ev.index].json += ev.delta.partial_json;
      if (ev.type === "content_block_stop" && partial[ev.index]) {
        const p = partial[ev.index]; yield { type: "toolCall", call: { id: p.id, name: p.name, arguments: p.json || "{}" } };
      }
      if (ev.type === "message_start") {
        responseModel = ev.message?.model ?? responseModel;
        const u = ev.message?.usage ?? {};
        usage = { inputTokens: u.input_tokens, cachedInputTokens: u.cache_read_input_tokens, outputTokens: u.output_tokens };
      }
      if (ev.type === "message_delta") {
        if (ev.usage?.output_tokens !== undefined) usage = { ...usage, outputTokens: ev.usage.output_tokens };
        if (ev.delta?.stop_reason) yield { type: "done", stopReason: ev.delta.stop_reason, usage, responseModel };
      }
    }
  }
}
