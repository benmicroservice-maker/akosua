import type { ToolDefinition } from "../providers/types.js";

export interface ToolContext { workspaceRoot: string; signal?: AbortSignal; }
export interface Tool {
  definition: ToolDefinition;
  /** Phases in which this tool may run. Enforced by the agent loop. */
  phases: Phase[];
  run(args: Record<string, unknown>, ctx: ToolContext, phase: Phase): Promise<string>;
}
export type Phase = "understand" | "research" | "plan" | "build" | "verify";

export class ToolRegistry {
  private tools = new Map<string, Tool>();
  register(t: Tool) { this.tools.set(t.definition.name, t); }
  get(name: string) { return this.tools.get(name); }
  definitionsFor(phase: Phase): ToolDefinition[] {
    return [...this.tools.values()].filter(t => t.phases.includes(phase)).map(t => t.definition);
  }
  async run(name: string, args: Record<string, unknown>, ctx: ToolContext, phase: Phase): Promise<string> {
    const t = this.tools.get(name);
    if (!t) return `Error: unknown tool "${name}". Available tools are listed in your tool definitions. Use one of those.`;
    if (!t.phases.includes(phase))
      return `Error: tool "${name}" is NOT available in the "${phase}" phase. ` +
        `Akosua enforces Understand -> Research -> Plan -> Build -> Verify. Finish the current phase first.`;
    try { return await t.run(args, ctx, phase); }
    catch (e) { return `Error running ${name}: ${(e as Error).message}`; }
  }
}
