import type { ChatMessage } from "../providers/types.js";

/** Context engineering (HARNESS_RESEARCH A1/A2). The model is only as good as
 * what fits in its window: Cursor/Claude-Code-class harnesses win by deciding
 * what the model sees. Three mechanical, model-free levers live here:
 *  1. shapeToolResult  — the MODEL gets parsed, error-first, size-capped tool
 *     output; the UI keeps the full text (loop yields the original separately).
 *  2. compactHistory   — as a run grows, stale tool results are truncated to
 *     head+tail digests and finally dropped to one-line summaries, preserving
 *     decisions (assistant/user text) and the most recent evidence verbatim.
 *  3. estimateTokens   — a cheap chars/4 heuristic used for budget accounting
 *     (no tokenizer dependency; conservative for code). */

export const est = (s: string): number => Math.ceil(s.length / 4);
export const historyTokens = (msgs: ChatMessage[]): number =>
  msgs.reduce((n, m) => n + est(m.content ?? "") + est(JSON.stringify(m.toolCalls ?? "")), 0);

const ERROR_LINE = /(error|Error|ERROR|failed|Failed|FAILED|✕|×|exception|Exception|at\s+\S+\s+\(|:\d+:\d+)/;

/** Error-first, size-capped rendering of a tool result FOR THE MODEL.
 * Keeps: first lines (context), all error-looking lines (signal), last lines
 * (verdicts/exit codes). Everything else is elided with an explicit marker so
 * the model knows evidence exists without paying tokens for bulk. */
export function shapeToolResult(result: string, maxChars = 6000): string {
  if (result.length <= maxChars) return result;
  const lines = result.split("\n");
  const head = lines.slice(0, 12).join("\n");
  const tail = lines.slice(-12).join("\n");
  const errors = lines.filter(l => ERROR_LINE.test(l)).slice(0, 30).join("\n");
  const shaped =
    `${head}\n…[elided ${result.length - maxChars} chars of tool output — error lines and head/tail kept]…\n` +
    (errors ? `ERROR LINES:\n${errors}\n` : "") + tail;
  return shaped.length > maxChars * 1.5 ? shaped.slice(0, maxChars * 1.5) : shaped;
}

/** One-line digest of a tool result, used when even head/tail is too much. */
export function digestToolResult(name: string | undefined, result: string): string {
  const firstLine = result.split("\n").find(l => l.trim()) ?? "";
  const fail = /\bFAIL|exit code [1-9]|Error/.test(result) ? " [contained errors]" : "";
  return `[earlier ${name ?? "tool"} result elided to save context${fail}: ${firstLine.slice(0, 160)}]`;
}

export interface CompactionReport { tokensBefore: number; tokensAfter: number; digested: number; truncated: number; }

/** Mutates history in place. Strategy, in order, until under budget:
 *  A. Truncate OLD tool results (>1500 chars) to head/tail (~700 chars).
 *  B. Replace the OLDEST remaining tool results with one-line digests.
 * System, user and assistant text are never altered — decisions survive;
 * bulk evidence is what compresses. Recent tool results (last 4) stay verbatim
 * because the agent is actively reasoning over them. */
export function compactHistory(msgs: ChatMessage[], budgetTokens: number): CompactionReport {
  const before = historyTokens(msgs);
  let digested = 0, truncated = 0;
  if (before <= budgetTokens) return { tokensBefore: before, tokensAfter: before, digested, truncated };
  const toolIdx = msgs.map((m, i) => (m.role === "tool" ? i : -1)).filter(i => i >= 0);
  const protectedIdx = new Set(toolIdx.slice(-4));
  // Pass A: truncate old, long tool results
  for (const i of toolIdx) {
    if (historyTokens(msgs) <= budgetTokens) break;
    if (protectedIdx.has(i)) continue;
    const c = msgs[i].content ?? "";
    if (c.length > 1500) {
      msgs[i] = { ...msgs[i], content: shapeToolResult(c, 700) };
      truncated++;
    }
  }
  // Pass B: digest oldest tool results entirely
  for (const i of toolIdx) {
    if (historyTokens(msgs) <= budgetTokens) break;
    if (protectedIdx.has(i)) continue;
    const c = msgs[i].content ?? "";
    if (!c.startsWith("[earlier ")) {
      msgs[i] = { ...msgs[i], content: digestToolResult(msgs[i].name, c) };
      digested++;
    }
  }
  return { tokensBefore: before, tokensAfter: historyTokens(msgs), digested, truncated };
}
