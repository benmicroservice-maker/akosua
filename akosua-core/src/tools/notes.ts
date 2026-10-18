import { promises as fs } from "node:fs";
import path from "node:path";
import type { Tool } from "../agent/tools.js";

/**
 * External memory (context-engineering canon): `.akosua/NOTES.md` is the
 * agent's durable notebook — decisions, open bugs, dead ends, stack gotchas.
 * Compaction may digest chat history, but the notebook persists on disk and
 * its head is re-injected into the system prompt on every run, so long
 * projects don't lose hard-won knowledge between sessions.
 */
export const NOTES_PATH = path.join(".akosua", "NOTES.md");
const MAX_NOTES_CHARS = 24_000;

export async function readNotes(root: string): Promise<string> {
  return fs.readFile(path.join(root, NOTES_PATH), "utf8").catch(() => "");
}

export const agentNotesTool: Tool = {
  definition: {
    name: "agent_notes",
    description: "Read or append to your durable project notebook (.akosua/NOTES.md). Use it for: decisions made and WHY, bugs found and their root causes, dead ends (so future sessions don't repeat them), stack/service gotchas, and open questions. Notes survive context compaction and future sessions — the head of the notebook is in your system prompt. Append dated, concise bullets; never paste large code.",
    parameters: { type: "object", required: ["command"], properties: {
      command: { type: "string", enum: ["read", "append"] },
      text: { type: "string", description: "For append: the note (markdown bullet(s))." },
    } },
  },
  phases: ["understand", "research", "plan", "build", "verify"],
  async run(a, ctx) {
    const abs = path.join(ctx.workspaceRoot, NOTES_PATH);
    if (a.command === "read") {
      const notes = await readNotes(ctx.workspaceRoot);
      return notes ? notes.slice(-MAX_NOTES_CHARS) : "(notebook is empty — start one with agent_notes append when you learn something durable)";
    }
    if (a.command === "append") {
      const text = String(a.text ?? "").trim();
      if (!text) return "Error: append needs 'text'.";
      await fs.mkdir(path.dirname(abs), { recursive: true });
      const existing = await readNotes(ctx.workspaceRoot);
      const header = existing ? "" : "# Akosua project notebook\nDurable memory: decisions, root causes, dead ends, gotchas. Newest at the bottom.\n";
      const stamp = new Date().toISOString().slice(0, 10);
      const entry = text.split("\n").map(l => l.trim().startsWith("-") ? l : `- ${l}`).join("\n");
      await fs.writeFile(abs, `${existing}${header}\n## ${stamp}\n${entry}\n`, "utf8");
      return `Noted in ${NOTES_PATH}. It will be in your system prompt head next run and survives compaction.`;
    }
    return `Error: unknown command "${a.command}". Use read|append.`;
  },
};
