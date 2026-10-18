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
    const abs = safe(ctx.workspaceRoot, a.path);
    if (a.command !== "create") {
      const st = await fs.stat(abs).catch(() => undefined);
      if (!st) return `Error: no such file: ${a.path}. Use list_files to see what exists, or create it in the build phase.`;
      if (!st.isFile()) return `Error: ${a.path} is a directory, not a file. Pick a file inside it (list_files can show you).`;
    }
    switch (a.command) {
      case "view": {
        const lines = (await fs.readFile(abs, "utf8")).split("\n");
        let [s, e] = Array.isArray(a.view_range) ? a.view_range as number[] : [1, lines.length];
        s = Math.max(1, Math.floor(s) || 1);               // tolerate 0-indexed callers
        e = !e || e < s ? lines.length : Math.min(Math.floor(e), lines.length);
        return lines.slice(s - 1, e).map((l, i) => `${s + i}: ${l}`).join("\n") || "(empty file)";
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
        const idx = content.indexOf(old);
        if (idx < 0) return `Error: old_str not found in ${a.path}. View the file and copy the exact text, including whitespace.`;
        if (content.indexOf(old, idx + 1) >= 0) return `Error: old_str occurs more than once in ${a.path}. Include more surrounding context to make it unique.`;
        await fs.writeFile(abs, content.slice(0, idx) + String(a.new_str ?? "") + content.slice(idx + old.length));
        return `Replaced text in ${a.path}`;
      }
      default: return `Error: unknown command "${a.command}". Use view|create|insert|str_replace.`;
    }
  },
};
