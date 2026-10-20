import type { ModelProvider, ChatMessage } from "../providers/types.js";

/**
 * Ghost-text completion engine (Cursor Tab analogue): given the code around
 * the cursor, predict the next chunk. Engineered for the autocomplete
 * contract: SHORT (never whole files), raw code only, stops at a natural
 * boundary. The host shows it as ghost text; Tab accepts. Deliberate guards:
 * overlong or fence-wrapped output is rejected so a chatty model can't dump.
 */
export interface GhostRequest {
  filePath: string; language: string;
  prefix: string;  // code before cursor (engine keeps the tail)
  suffix: string;  // code after cursor (fill-in-the-middle awareness)
}

export async function ghostComplete(provider: ModelProvider, model: string, r: GhostRequest): Promise<string> {
  const prefix = r.prefix.slice(-3000);
  const suffix = r.suffix.slice(0, 1200);
  const msgs: ChatMessage[] = [{
    role: "user",
    content: `You are a code autocomplete engine. Continue the code at <CURSOR> in ${r.filePath} (${r.language}).
Rules: output ONLY the raw code that belongs at the cursor — no fences, no explanation, no repeating the prefix. Complete at most ~10 lines, stopping at a natural boundary. Respect the suffix: your completion must flow into it.

${prefix}<CURSOR>${suffix}`,
  }];
  let text = "";
  for await (const ev of provider.complete({ model, messages: msgs, tools: [], maxTokens: 512 })) {
    if (ev.type === "text") text += ev.delta;
  }
  const cleaned = text.replace(/^```[a-z]*\n?/i, "").replace(/\n?```\s*$/i, "");
  if (cleaned.length > 1200 || cleaned.split("\n").length > 12) return ""; // refuse: autocomplete must be a whisper, not a speech
  if (prefix.endsWith(cleaned) && cleaned.length > 0) return ""; // pure echo
  return cleaned;
}
