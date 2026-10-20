import type { ChatMessage } from "../providers/types.js";

/** Context engineering v2 (TERMINAL_AND_CONTEXT_RESEARCH.md).
 * Anthropic's Write/Select/Compress/Isolate, made mechanical:
 *  1. CAP FIRST — every tool result is shaped per-tool before the model
 *     sees it (capping alone is the single biggest cost/quality lever;
 *     LLM compaction is the fallback, never the first move).
 *  2. STAGED COMPACTION — pressure levels 70/80/90%: truncate, then
 *     digest old observations, protecting more recent evidence when
 *     pressure is low and less when it is desperate. Decisions
 *     (user/assistant text) are never altered; bulk evidence compresses.
 *  3. BUDGET TO THE EFFECTIVE WINDOW — callers pass a budget that is a
 *     fraction (~75%) of the model's rated window, never the ceiling.
 *  4. ISOLATE — sub-agent digests (delegate.ts) keep raw exploration
 *     out of this history entirely; EXTERNALIZE — notes/checkpoints/git
 *     hold durable state outside the window. */

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
  // Proportional head/tail: ordinary tools keep a sketch; high-cap tools
  // (terminal/verification verdicts live near the end) keep real bulk.
  // Previously a flat 12+12 lines made EVERY cap produce ~1.7KB, so the
  // per-tool caps below bought nothing (caught by context-v2 tests).
  const lineBudget = Math.max(24, Math.floor(maxChars / 60));
  const head = lines.slice(0, Math.floor(lineBudget / 2)).join("\n");
  const tail = lines.slice(-Math.ceil(lineBudget / 2)).join("\n");
  const errors = lines.filter(l => ERROR_LINE.test(l)).slice(0, 30).join("\n");
  const errBlock = errors ? `ERROR LINES:\n${errors}\n` : "";
  const marker = `\n…[elided ${result.length - maxChars} chars of tool output — error lines and head/tail kept]…\n`;
  const shaped = `${head}${marker}${errBlock}${tail}`;
  return shaped.length > maxChars ? shaped.slice(0, maxChars) : shaped;
}

/** Per-tool caps: noisy tools (terminals, verification) earn more room
 * because their tails carry verdicts; lookups earn less. Unknown tools
 * get the conservative default. */
const TOOL_CAPS: Record<string, number> = {
  terminal: 12_000, terminal_jobs: 8_000, run_verification: 10_000,
  file_editor: 9_000, diagnostics: 8_000, formatter: 4_000,
  search_code: 8_000, semantic_search: 8_000, list_files: 5_000,
  delegate_research: 7_500, delegate_research_batch: 12_000,
};
export function shapeToolResultFor(name: string | undefined, result: string): string {
  return shapeToolResult(result, TOOL_CAPS[name ?? ""] ?? 6000);
}

/** One-line digest of a tool result, used when even head/tail is too much. */
export function digestToolResult(name: string | undefined, result: string): string {
  const firstLine = result.split("\n").find(l => l.trim()) ?? "";
  const fail = /\bFAIL|exit code [1-9]|Error/.test(result) ? " [contained errors]" : "";
  return `[earlier ${name ?? "tool"} result elided to save context (${result.length} chars${fail}): ${firstLine.slice(0, 160)}]`;
}

export type ContextPressure = "ok" | "warn" | "mask" | "prune";
/** Staged pressure: <70% ok, 70-80% warn (truncate), 80-90% mask
 * (digest aggressively), >=90% prune (protect only the freshest). */
export function contextPressure(tokens: number, budgetTokens: number): ContextPressure {
  const r = budgetTokens > 0 ? tokens / budgetTokens : 0;
  return r >= 0.9 ? "prune" : r >= 0.8 ? "mask" : r >= 0.7 ? "warn" : "ok";
}
/** Effective working budget: a fraction of the rated window (research:
 * quality rots well before the ceiling; reserve headroom to think). */
export const effectiveBudget = (ratedWindowTokens: number, fraction = 0.75): number =>
  Math.floor(ratedWindowTokens * fraction);

export interface CompactionReport { tokensBefore: number; tokensAfter: number; digested: number; truncated: number; pressure: ContextPressure; protectedCount: number; }

/** Mutates history in place. Strategy, in order, until under budget:
 *  A. Truncate OLD tool results (>1500 chars) to head/tail (~700 chars).
 *  B. Replace the OLDEST remaining tool results with one-line digests.
 * System, user and assistant text are never altered — decisions survive;
 * bulk evidence is what compresses. Recent tool results stay verbatim
 * (the agent is actively reasoning over them); how many survive scales
 * DOWN with pressure (prune protects 4, warn protects 12). Short
 * histories are never touched (compaction overhead > benefit). */
export function compactHistory(msgs: ChatMessage[], budgetTokens: number): CompactionReport {
  const before = historyTokens(msgs);
  const pressure = contextPressure(before, budgetTokens);
  let digested = 0, truncated = 0;
  const protectedCount = pressure === "prune" ? 4 : pressure === "mask" ? 8 : 12;
  const base: CompactionReport = { tokensBefore: before, tokensAfter: before, digested, truncated, pressure, protectedCount };
  if (before <= budgetTokens || before < 8000) return base;
  const toolIdx = msgs.map((m, i) => (m.role === "tool" ? i : -1)).filter(i => i >= 0);
  const protectedIdx = new Set(toolIdx.slice(-protectedCount));
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
  return { tokensBefore: before, tokensAfter: historyTokens(msgs), digested, truncated, pressure, protectedCount };
}
