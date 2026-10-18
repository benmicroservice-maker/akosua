import { promises as fs } from "node:fs";
import path from "node:path";

/**
 * Skills (SKILL.md pattern): reusable expertise packs the user/team authors
 * once and the agent loads on demand. Location: `.akosua/skills/<name>.md`
 * (project) — a header line `# Skill: <when to use this>` then the playbook.
 * The system prompt carries only the INDEX (name + when); the agent reads a
 * skill's full text via the skill tool when its trigger matches. Knowledge
 * stays versioned in the repo instead of evaporating into chat history.
 */
export interface SkillInfo { name: string; when: string; file: string; }

export async function listSkills(root: string): Promise<SkillInfo[]> {
  const dir = path.join(root, ".akosua", "skills");
  const names = await fs.readdir(dir).catch(() => [] as string[]);
  const out: SkillInfo[] = [];
  for (const name of names.filter(n => n.endsWith(".md")).slice(0, 40)) {
    const text = await fs.readFile(path.join(dir, name), "utf8").catch(() => "");
    const firstLine = text.split("\n").find(l => l.trim()) ?? "";
    const when = firstLine.replace(/^#+\s*/, "").replace(/^Skill:\s*/i, "").slice(0, 160) || "general playbook";
    out.push({ name: name.replace(/\.md$/, ""), when, file: name });
  }
  return out;
}

export function renderSkillIndex(skills: SkillInfo[]): string {
  if (!skills.length) return "";
  return `\n\n# Skills available (.akosua/skills/ — load with the skill tool when a trigger matches; they are proven playbooks, follow them):\n${skills.map(s => `- ${s.name}: ${s.when}`).join("\n")}`;
}

export const skillTool = {
  definition: {
    name: "skill",
    description: "Load one of the project's authored Skills (.akosua/skills/<name>.md): proven playbooks for recurring work (e.g. adding a NestJS endpoint, shipping a Flutter screen, writing a migration). Check the Skills index in your instructions; when the task matches a skill's trigger, load it BEFORE planning and follow it. Skills outrank generic habit where they conflict.",
    parameters: { type: "object", required: ["name"], properties: { name: { type: "string" } } },
  },
  phases: ["understand", "research", "plan", "build"] as const,
  async run(a: Record<string, unknown>, ctx: { workspaceRoot: string }) {
    const name = String(a.name ?? "").replace(/[^\w.-]+/g, "");
    if (!name) return "Error: skill needs a 'name' from the Skills index.";
    const file = path.join(ctx.workspaceRoot, ".akosua", "skills", `${name}.md`);
    const text = await fs.readFile(file, "utf8").catch(() => undefined);
    if (text === undefined) return `Error: no skill named "${name}". Available skills are in your Skills index — use list_files on .akosua/skills if unsure.`;
    return `--- SKILL ${name} (follow this playbook) ---\n${text.slice(0, 16_000)}`;
  },
};
