import { promises as fs } from "node:fs";
import path from "node:path";

/**
 * @-mentions: `@path/to/file.ts` (optionally `:10-40`) in a user message pins
 * that file (or range) into the agent's context verbatim — the user, not the
 * retriever, decides this evidence matters. Paths are workspace-contained
 * (same separator-aware rule as the file editor); oversized pins are capped
 * with the truncation stated, never silent.
 */
export interface Mention { raw: string; path: string; from?: number; to?: number; }
const MAX_PIN_CHARS = 20_000;

export function parseMentions(text: string): Mention[] {
  const out: Mention[] = [];
  for (const m of text.matchAll(/@([\w./-]*\/[\w./-]+\.[\w]+)(?::(\d+)(?:-(\d+))?)?/g)) {
    out.push({ raw: m[0], path: m[1], from: m[2] ? Number(m[2]) : undefined, to: m[3] ? Number(m[3]) : undefined });
  }
  return out;
}

export async function resolveMentions(root: string, text: string): Promise<string> {
  const mentions = parseMentions(text);
  if (!mentions.length) return "";
  const rootAbs = path.resolve(root);
  const blocks: string[] = [];
  for (const m of mentions.slice(0, 8)) {
    const abs = path.resolve(rootAbs, m.path);
    if (abs !== rootAbs && !abs.startsWith(rootAbs + path.sep)) { blocks.push(`@${m.path}: SKIPPED (outside workspace)`); continue; }
    const content = await fs.readFile(abs, "utf8").catch(() => undefined);
    if (content === undefined) { blocks.push(`@${m.path}: NOT FOUND (check the path; use list_files if unsure)`); continue; }
    let lines = content.split("\n");
    if (m.from) lines = lines.slice(Math.max(0, m.from - 1), m.to ?? lines.length);
    let body = lines.join("\n");
    if (body.length > MAX_PIN_CHARS) body = body.slice(0, MAX_PIN_CHARS) + `\n…[pinned file truncated at ${MAX_PIN_CHARS} chars — pin a :from-to range for the rest]`;
    blocks.push(`--- PINNED BY USER @${m.path}${m.from ? `:${m.from}-${m.to ?? ""}` : ""} ---\n${body}`);
  }
  return blocks.length ? `\n\n# User-pinned context (verbatim, treat as ground truth for this task):\n${blocks.join("\n\n")}` : "";
}
