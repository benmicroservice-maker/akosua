import type { SecretStore } from "../secrets.js";
import { SecretKeys } from "../secrets.js";
import type { CompletionRequest, FetchLike, ModelProvider, StreamEvent } from "./types.js";

export class OpenAIProvider implements ModelProvider {
  readonly id = "openai" as const;
  constructor(private secrets: SecretStore, private fetchFn: FetchLike = fetch as never) {}
  async *complete(req: CompletionRequest): AsyncIterable<StreamEvent> {
    const key = await this.secrets.get(SecretKeys.openai);
    if (!key) throw new Error("OpenAI API key not set (Settings -> Providers & Keys)");
    const messages = req.messages.map(m => m.role === "tool"
      ? { role: "tool", tool_call_id: m.toolCallId, content: m.content }
      : { role: m.role, content: m.content || null,
          ...(m.toolCalls?.length ? { tool_calls: m.toolCalls.map(tc => ({ id: tc.id, type: "function", function: { name: tc.name, arguments: tc.arguments } })) } : {}) });
    const res = await this.fetchFn("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
      body: JSON.stringify({ model: req.model, messages, max_tokens: req.maxTokens, temperature: req.temperature,
        tools: req.tools?.map(t => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.parameters } })),
        stream: true }),
    });
    if (!res.ok) throw new Error(`OpenAI ${res.status}: ${await res.text()}`);
    const dec = new TextDecoder(); let buf = "";
    const partial: Record<number, { id: string; name: string; args: string }> = {};
    for await (const chunk of res.body!) {
      buf += dec.decode(chunk as never, { stream: true } as never);
      let i: number;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
        if (!line.startsWith("data:")) continue;
        const data = line.slice(5).trim();
        if (data === "[DONE]") { yield { type: "done", stopReason: "stop" }; continue; }
        let ev: any; try { ev = JSON.parse(data); } catch { continue; }
        const choice = ev.choices?.[0]; if (!choice) continue;
        if (choice.delta?.content) yield { type: "text", delta: choice.delta.content };
        for (const tc of choice.delta?.tool_calls ?? []) {
          const p = (partial[tc.index] ??= { id: tc.id ?? "", name: "", args: "" });
          if (tc.id) p.id = tc.id;
          if (tc.function?.name) p.name = tc.function.name;
          if (tc.function?.arguments) p.args += tc.function.arguments;
        }
        if (choice.finish_reason) for (const p of Object.values(partial)) if (p.name) yield { type: "toolCall", call: { id: p.id, name: p.name, arguments: p.args || "{}" } };
      }
    }
  }
}
