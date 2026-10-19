import type { ChatMessage, ModelProvider, ToolDefinition } from "../providers/types.js";
import type { Tool } from "./tools.js";

/**
 * Sub-agent digests (context-engineering canon): a focused research sub-agent
 * burns ITS OWN context on searches/scrapes and returns a 1–2k-token digest
 * with sources. The main agent's history stays clean — it reads conclusions,
 * not ten scraped pages. Bounded: max 6 tool turns, digest hard-capped.
 */
export interface DelegateDeps {
  provider: ModelProvider; model: string;
  tools: Tool[];               // research/codebase subset (already phase-safe tools)
  workspaceRoot: string;
}

const SUB_PROMPT = `You are Akosua's research sub-agent. Answer the delegated question using ONLY the tools given (docs lookup first — Context7 before web search; web search for implementations/solutions; package registry for versions).
Rules:
- Verify against version-pinned docs where a library is involved. Community/video ideas must be labelled IDEA (unverified).
- Finish with "DIGEST:" followed by a tight summary: findings, exact versions/APIs, file paths if codebase-related, and a Sources list (URLs / doc names / paths). The digest is all the main agent will see — make it complete but under ~1500 tokens.
- No code edits exist in your toolset by design.`;

export function createDelegateResearchTool(deps: DelegateDeps): Tool {
  const defs: ToolDefinition[] = deps.tools.map(t => t.definition);
  const byName = new Map(deps.tools.map(t => [t.definition.name, t]));
  return {
    definition: {
      name: "delegate_research",
      description: "Delegate a self-contained research question to a sub-agent (docs/web/codebase investigation). It explores with its own context and returns a concise cited DIGEST — use this for broad investigations so your own context stays clean. One question per call; be specific (library + version + what decision the answer informs).",
      parameters: { type: "object", required: ["question"], properties: { question: { type: "string" } } },
    },
    phases: ["understand", "research", "plan"],
    async run(a, ctx) {
      const question = String(a.question ?? "").trim();
      if (!question) return "Error: delegate_research needs a specific 'question'.";
      const msgs: ChatMessage[] = [
        { role: "system", content: SUB_PROMPT },
        { role: "user", content: `Workspace: ${deps.workspaceRoot}\n\nQUESTION: ${question}` },
      ];
      let finalText = "";
      for (let turn = 0; turn < 6; turn++) {
        let text = ""; const calls: { id: string; name: string; arguments: string }[] = [];
        for await (const ev of deps.provider.complete({ model: deps.model, messages: msgs, tools: defs })) {
          if (ev.type === "text") text += ev.delta;
          else if (ev.type === "toolCall") calls.push(ev.call);
        }
        finalText = text;
        if (!calls.length) break;
        msgs.push({ role: "assistant", content: text, toolCalls: calls });
        for (const c of calls) {
          const tool = byName.get(c.name);
          let out: string;
          if (!tool) out = `Error: unknown tool ${c.name}`;
          else {
            let args: Record<string, unknown> = {};
            try { args = JSON.parse(c.arguments || "{}"); } catch { /* empty */ }
            try { out = await tool.run(args, { workspaceRoot: deps.workspaceRoot } as never, "research"); }
            catch (e) { out = `Error: ${(e as Error).message}`; }
          }
          msgs.push({ role: "tool", toolCallId: c.id, content: out.slice(0, 9000) });
        }
      }
      const digestAt = finalText.indexOf("DIGEST:");
      const digest = (digestAt >= 0 ? finalText.slice(digestAt) : finalText).trim();
      if (!digest) return "Sub-agent returned no digest (it may have exhausted its turns). Narrow the question and retry, or research directly.";
      return `SUB-AGENT DIGEST (verify critical claims before acting):\n${digest.slice(0, 7000)}`;
    },
  };
}

/** Parallel delegation: several independent questions fan out concurrently
 * (bounded), digests come back labelled per question. Independence is the
 * caller's claim — the tool enforces only the bound. Failures degrade to a
 * per-question note, never a lost batch. */
export function createDelegateBatchTool(deps: DelegateDeps): Tool {
  const single = createDelegateResearchTool(deps);
  return {
    definition: {
      name: "delegate_research_batch",
      description: "Delegate UP TO 4 INDEPENDENT research questions in parallel (e.g. docs for two libraries + one codebase question). Each sub-agent returns its own cited digest. Use when investigations don't depend on each other's answers — it's much faster than serial delegation. Dependent questions belong in sequence, not here.",
      parameters: { type: "object", required: ["questions"], properties: { questions: { type: "array", items: { type: "string" } } } },
    },
    phases: ["understand", "research", "plan"],
    async run(a, ctx) {
      const questions = (Array.isArray(a.questions) ? a.questions : []).map(q => String(q).trim()).filter(Boolean).slice(0, 4);
      if (!questions.length) return "Error: delegate_research_batch needs 1-4 non-empty 'questions'.";
      const results = await Promise.all(questions.map(async (q, i) => {
        try { return `### Q${i + 1}: ${q}\n${await single.run({ question: q }, ctx, "research")}`; }
        catch (e) { return `### Q${i + 1}: ${q}\nSub-agent failed: ${(e as Error).message} — research this one directly.`; }
      }));
      return results.join("\n\n").slice(0, 20_000);
    },
  };
}
