import { promises as fs } from "node:fs";
import path from "node:path";
import type { Tool, ToolContext } from "../agent/tools.js";

function safe(root: string, p: string): string {
  const r = path.resolve(root);
  const abs = path.resolve(r, p);
  // Separator-aware containment: a naive startsWith(r) lets "../ws-evil"
  // escape a workspace at "/ws" (audit finding).
  if (abs !== r && !abs.startsWith(r + path.sep)) throw new Error(`Path escapes workspace: ${p}`);
  return abs;
}

/** Agent file-access policy (hardening): even INSIDE the workspace the
 * agent must not read secrets / VCS internals, nor write lockfiles or
 * Akosua state; and a symlink planted in the workspace must not become a
 * tunnel out of it. Refusals are returned as tool errors so the model
 * adapts instead of retrying blindly. */
const LOCKFILES = new Set(["package-lock.json", "yarn.lock", "pnpm-lock.yaml", "pubspec.lock", "Cargo.lock", "Gemfile.lock", "composer.lock", "poetry.lock", "Pipfile.lock"]);
const SECRET_BASENAME = [/^\.env($|\.)/, /\.pem$/i, /\.key$/i, /^id_(rsa|dsa|ecdsa|ed25519)/, /^\.npmrc$/, /^\.netrc$/];
const SECRET_EXEMPT = new Set([".env.example", ".env.sample", ".env.template", ".env.local.example"]);

export function protectedReason(rel: string, mutation: boolean): string | undefined {
  const parts = rel.split(path.sep).filter(Boolean);
  const base = parts[parts.length - 1] ?? "";
  if (parts[0] === ".git") return "protected path (.git internals are not agent-readable or writable)";
  if (SECRET_BASENAME.some(re => re.test(base)) && !SECRET_EXEMPT.has(base))
    return "protected path (secret-bearing file — keys and credentials never enter agent context; ask the user to inspect it)";
  if (mutation && parts[0] === ".akosua") return "protected path (Akosua state is host-managed; use the brain/notes features instead of editing it directly)";
  if (mutation && LOCKFILES.has(base)) return "protected path (lockfiles are written by package managers, never by hand — run the install command instead)";
  return undefined;
}

/** Lexical containment (safe) + policy + symlink resolution: the REAL
 * target (nearest existing ancestor resolved) must stay inside the
 * REAL workspace root. */
export async function resolveWithin(root: string, p: string, mutation: boolean): Promise<{ abs: string } | { error: string }> {
  let abs: string;
  try { abs = safe(root, p); } catch (e) { return { error: (e as Error).message }; }
  const rel = path.relative(path.resolve(root), abs);
  const why = protectedReason(rel, mutation);
  if (why) return { error: `${why}: ${p}` };
  try {
    const realRoot = await fs.realpath(root);
    let probe = abs; const rest: string[] = [];
    for (;;) {
      try {
        const real = await fs.realpath(probe);
        const target = rest.length ? path.join(real, ...rest) : real;
        if (target !== realRoot && !target.startsWith(realRoot + path.sep))
          return { error: `Path escapes workspace (symlink): ${p}` };
        break;
      } catch {
        const parent = path.dirname(probe);
        if (parent === probe) break;
        rest.unshift(path.basename(probe)); probe = parent;
      }
    }
  } catch { /* realpath unavailable: lexical containment already applied */ }
  return { abs };
}

/** Tiered match for str_replace (Fast-Apply lesson): exact first; then a
 * line-wise whitespace-tolerant match (indentation/trailing drift); the
 * replacement text lands exactly as the model wrote it. Ambiguity at any tier
 * is an error, never a guess. Returns [startIdx, endIdxExclusive] in `content`. */
export function findReplaceRange(content: string, old: string): { start: number; end: number; tier: string } | { error: string } {
  const idx = content.indexOf(old);
  if (idx >= 0) {
    if (content.indexOf(old, idx + 1) >= 0) return { error: "old_str occurs more than once. Include more surrounding context to make it unique." };
    return { start: idx, end: idx + old.length, tier: "exact" };
  }
  const norm = (s: string) => s.split("\n").map(l => l.trim());
  const contentLines = content.split("\n"); const oldLines = norm(old);
  while (oldLines.length && oldLines[oldLines.length - 1] === "") oldLines.pop();
  while (oldLines.length && oldLines[0] === "") oldLines.shift();
  if (!oldLines.length) return { error: "old_str is empty after trimming." };
  const hits: number[] = [];
  outer: for (let i = 0; i + oldLines.length <= contentLines.length; i++) {
    for (let j = 0; j < oldLines.length; j++) if (contentLines[i + j].trim() !== oldLines[j]) continue outer;
    hits.push(i);
  }
  if (hits.length > 1) return { error: "old_str matches multiple locations once whitespace is ignored. Include more surrounding context." };
  if (!hits.length) return { error: "not found (tried exact and whitespace-tolerant match). View the file and copy the exact text." };
  const startLine = hits[0];
  const starts: number[] = [0];
  for (let i = 0; i < contentLines.length; i++) starts.push(starts[i] + contentLines[i].length + 1);
  return { start: starts[startLine], end: starts[startLine + oldLines.length] - 1, tier: "whitespace-tolerant" };
}

/** Surgical file editor (nanoclaude lesson): view/create/insert/str_replace. */
export const fileEditorTool: Tool = {
  definition: { name: "file_editor", description:
    "View, create, insert into, or surgically replace text in a workspace file. Prefer str_replace with a unique old_str over rewriting whole files. Paths are relative to the workspace root.",
    parameters: { type: "object", required: ["command", "path"], properties: {
      command: { type: "string", enum: ["view", "create", "insert", "str_replace"] },
      path: { type: "string" }, file_text: { type: "string" },
      old_str: { type: "string" }, new_str: { type: "string" },
      insert_line: { type: "number" }, view_range: { type: "array", items: { type: "number" } } } } },
  phases: ["understand", "build", "verify"],
  async run(a, ctx: ToolContext, phase) {
    // GRAIN OF THE GATE: viewing is allowed while understanding/verifying,
    // but ANY mutation requires the build phase.
    if (a.command !== "view" && phase !== "build")
      return `Error: file_editor "${a.command}" is a mutation and is only allowed in the "build" phase (current: "${phase}"). ` +
        `In "understand" you may only view files. Finish Understand -> Research -> Plan first.`;
    if (!a.path || typeof a.path !== "string") return `Error: file_editor "${a.command}" needs a "path" (workspace-relative file path). You called it without one. View a real file from list_files/project_brain output.`;
    const resolved = await resolveWithin(ctx.workspaceRoot, a.path, a.command !== "view");
    if ("error" in resolved) return `Error: ${resolved.error}`;
    const abs = resolved.abs;
    if (a.command !== "create") {
      const st = await fs.stat(abs).catch(() => undefined);
      if (!st) return `Error: no such file: ${a.path}. Use list_files to see what exists, or create it in the build phase.`;
      if (!st.isFile()) return `Error: ${a.path} is a directory, not a file. Pick a file inside it (list_files can show you).`;
    }
    switch (a.command) {
      case "view": {
        const lines = (await fs.readFile(abs, "utf8")).split("\n");
        const ranged = Array.isArray(a.view_range);
        let [s, e] = ranged ? a.view_range as number[] : [1, lines.length];
        s = Math.max(1, Math.floor(s) || 1);               // tolerate 0-indexed callers
        e = !e || e < s ? lines.length : Math.min(Math.floor(e), lines.length);
        // Context hygiene: an unbounded view of a huge file burns the
        // window for nothing. Cap at 400 lines and say exactly how to
        // page — the model asks for the range it actually needs.
        const CAP = 400;
        const capped = e - s + 1 > CAP;
        if (capped) e = s + CAP - 1;
        const body = lines.slice(s - 1, e).map((l, i) => `${s + i}: ${l}`).join("\n") || "(empty file)";
        return capped ? `${body}\n…[view capped: lines ${s}-${e} of ${lines.length}. Call view again with view_range [${e + 1}, ${Math.min(lines.length, e + CAP)}] for the next chunk — do not re-read what you have.]` : body;
      }
      case "create": {
        await fs.mkdir(path.dirname(abs), { recursive: true });
        try { await fs.access(abs); return `Error: file already exists: ${a.path}. Use str_replace to edit it.`; }
        catch { await fs.writeFile(abs, String(a.file_text ?? "")); return `Created ${a.path}`; }
      }
      case "insert": {
        const lines = (await fs.readFile(abs, "utf8")).split("\n");
        const at = Math.max(0, Math.min(Number(a.insert_line ?? lines.length), lines.length));
        lines.splice(at, 0, String(a.file_text ?? "")); await fs.writeFile(abs, lines.join("\n"));
        return `Inserted at line ${at + 1} in ${a.path}`;
      }
      case "str_replace": {
        const content = await fs.readFile(abs, "utf8"); const old = String(a.old_str ?? "");
        if (!old) return "Error: old_str is empty. Provide the exact unique text to replace.";
        const m = findReplaceRange(content, old);
        if ("error" in m) return `Error: old_str ${m.error} (${a.path})`;
        await fs.writeFile(abs, content.slice(0, m.start) + String(a.new_str ?? "") + content.slice(m.end));
        return `Replaced text in ${a.path}${m.tier === "exact" ? "" : " (matched with whitespace tolerance — the file's drift differed from your old_str; your new_str was applied verbatim)"}`;
      }
      default: return `Error: unknown command "${a.command}". Use view|create|insert|str_replace.`;
    }
  },
};
