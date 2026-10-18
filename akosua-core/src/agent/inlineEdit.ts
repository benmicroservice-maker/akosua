import type { ModelProvider, ChatMessage } from "../providers/types.js";

/**
 * Inline-edit engine (C1 groundwork): Cursor-style "select code, describe the
 * change" as a pure core service. The fork/extension supplies the selection;
 * this returns replacement text for EXACTLY that range plus an explanation.
 * Deliberately conservative: the model must echo nothing but the replacement;
 * anything that looks like a whole-file dump is rejected (>4x range growth
 * without newlines added by the user instruction is suspicious) so the UI can
 * refuse rather than clobber.
 */
export interface InlineEditRequest {
  filePath: string;
  language: string;
  /** Full text of the selected range (may be empty for pure insertion). */
  selection: string;
  /** Lines before/after the selection for context. */
  prefix: string;
  suffix: string;
  instruction: string;
}
export interface InlineEditResult { replacement: string; explanation: string; }

const PROMPT = (r: InlineEditRequest) => `You are Akosua's inline editor. Rewrite ONLY the selected range per the instruction.

Rules:
- Output the replacement for the selected range and nothing else — no markdown fences, no commentary inside the code.
- Preserve indentation style and naming conventions visible in the context.
- Do not invent APIs: if the instruction requires something not visible in context, still produce the minimal faithful edit.

FILE: ${r.filePath} (${r.language})
--- CONTEXT BEFORE ---
${r.prefix}
--- SELECTED RANGE (replace this) ---
${r.selection}
--- CONTEXT AFTER ---
${r.suffix}
--- INSTRUCTION ---
${r.instruction}`;

export async function inlineEdit(provider: ModelProvider, model: string, r: InlineEditRequest): Promise<InlineEditResult> {
  const msgs: ChatMessage[] = [{ role: "user", content: PROMPT(r) }];
  let text = "";
  for await (const ev of provider.complete({ model, messages: msgs, tools: [] })) {
    if (ev.type === "text") text += ev.delta;
  }
  const cleaned = text.replace(/^```[a-z]*\n?/i, "").replace(/\n?```\s*$/i, "");
  if (r.selection && cleaned.length > Math.max(4000, r.selection.length * 6)) {
    throw new Error("Inline edit rejected: model returned far more than the selected range (possible whole-file dump). Narrow the selection or use the full agent.");
  }
  const firstLine = cleaned.split("\n")[0] ?? "";
  return { replacement: cleaned, explanation: `Inline edit in ${r.filePath}: ${r.instruction} (was ${r.selection.split("\n").length} line(s), now ${cleaned.split("\n").length}; starts: ${firstLine.slice(0, 80)})` };
}
