import { promises as fs } from "node:fs";
import path from "node:path";
import type { Tool } from "../agent/tools.js";
import { fingerprintProject } from "../context/fingerprint.js";
import { indexProject, renderBrainV2, walk } from "../context/indexer.js";

/** Understand-phase tools: see the codebase before reasoning about it. */

export const listFilesTool: Tool = {
  definition: { name: "list_files", description: "List files in the workspace (or a subfolder), e.g. to learn the project layout. Ignores node_modules/.git/build output. Returns relative paths.",
    parameters: { type: "object", properties: { subdir: { type: "string" }, max: { type: "number" } } } },
  phases: ["understand", "plan"],
  async run(a, ctx) {
    const base = a.subdir ? path.join(ctx.workspaceRoot, String(a.subdir)) : ctx.workspaceRoot;
    const out: string[] = [];
    for await (const abs of walk(base)) { out.push(path.relative(ctx.workspaceRoot, abs)); if (out.length >= Number(a.max ?? 500)) break; }
    return out.join("\n") || "(no source files found)";
  },
};

export const searchCodeTool: Tool = {
  definition: { name: "search_code", description: "Search the codebase for a text/regex pattern and get file:line matches. Use this to PROVE where something exists (callers, definitions, usages) instead of guessing. Case-insensitive substring by default; set regex=true for a JS regex.",
    parameters: { type: "object", required: ["query"], properties: { query: { type: "string" }, regex: { type: "boolean" }, max: { type: "number" } } } },
  phases: ["understand", "build", "verify"],
  async run(a, ctx) {
    const q = String(a.query); const max = Number(a.max ?? 60);
    const test = a.regex ? new RegExp(q, "i") : null;
    const hits: string[] = [];
    for await (const abs of walk(ctx.workspaceRoot)) {
      let content: string; try { content = await fs.readFile(abs, "utf8"); } catch { continue; }
      const lines = content.split("\n");
      for (let i = 0; i < lines.length; i++) {
        if (test ? test.test(lines[i]) : lines[i].toLowerCase().includes(q.toLowerCase())) {
          hits.push(`${path.relative(ctx.workspaceRoot, abs)}:${i + 1}: ${lines[i].trim().slice(0, 200)}`);
          if (hits.length >= max) return hits.join("\n") + `\n…[stopped at ${max} matches]`;
        }
      }
    }
    return hits.join("\n") || `No matches for "${q}". That absence is evidence: do not assume it exists under another name — search differently or state it is not present.`;
  },
};

export const projectBrainTool: Tool = {
  definition: { name: "project_brain", description: "Generate/refresh the Project Brain for this workspace: stack fingerprint (frameworks, transports, ORM), file/symbol index and the HTTP+event contract map. Run this FIRST in the Understand phase and base your understanding statement on its output.",
    parameters: { type: "object", properties: {} } },
  phases: ["understand"],
  async run(_a, ctx) {
    const fp = await fingerprintProject(ctx.workspaceRoot);
    const idx = await indexProject(ctx.workspaceRoot);
    return renderBrainV2(fp, idx);
  },
};
