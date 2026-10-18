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
    // GPT-6-class models reason by default, and Chat Completions rejects
    // function tools combined with reasoning effort ("Function tools with
    // reasoning_effort are not supported ... set reasoning_effort to
    // 'none'"). Akosua always calls with tools, so pin it off explicitly.
    // Token limit: GPT-5/6-class models REQUIRE max_completion_tokens and
    // reject max_tokens (400 unsupported_parameter). Parameter negotiation:
    // on a 400 that names an unsupported parameter, swap/drop exactly that
    // parameter and retry (max 3 attempts) — model families differ and
    // Akosua never guesses which generation it is talking to.
    const payload: Record<string, unknown> = { model: req.model, messages,
      ...(req.maxTokens ? { max_completion_tokens: req.maxTokens } : {}),
      ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
      ...(req.tools?.length ? { reasoning_effort: "none" } : {}),
      tools: req.tools?.map(t => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.parameters } })),
      stream: true };
    const post = () => this.fetchFn("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
      body: JSON.stringify(payload),
    });
    let res = await post();
    for (let attempt = 0; !res.ok && res.status === 400 && attempt < 3; attempt++) {
      const errText = await res.text();
      let adjusted = false;
      if (errText.includes("max_completion_tokens") && payload.max_completion_tokens !== undefined) {
        payload.max_tokens = payload.max_completion_tokens; delete payload.max_completion_tokens; adjusted = true;
      } else if (errText.includes("max_tokens") && payload.max_tokens !== undefined) {
        payload.max_completion_tokens = payload.max_tokens; delete payload.max_tokens; adjusted = true;
      }
      if (errText.includes("temperature") && "temperature" in payload) { delete payload.temperature; adjusted = true; }
      if (errText.includes("reasoning_effort") && "reasoning_effort" in payload) { delete payload.reasoning_effort; adjusted = true; }
      if (!adjusted) throw new Error(`OpenAI 400: ${errText}`);
      res = await post();
    }
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
