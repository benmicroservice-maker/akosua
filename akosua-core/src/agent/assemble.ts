import { promises as fs } from "node:fs";
import path from "node:path";
import { SecretKeys, type SecretStore } from "../secrets.js";
import type { ModelProvider } from "../providers/types.js";
import { Agent, AKOSUA_SYSTEM_PROMPT, type ModelRouting } from "./loop.js";
import { ToolRegistry } from "./tools.js";
import { fileEditorTool } from "../tools/fileEditor.js";
import { terminalTool, PersistentTerminal } from "../tools/terminal.js";
import { BackgroundJobManager, terminalJobsTool } from "../tools/terminalJobs.js";
import { createGitCheckpointTool, ensureAkosuaStateIgnored } from "../tools/git.js";
import { quickDiagnostics } from "../context/diagnostics.js";
import { runFormatting } from "../context/format.js";
import { listFilesTool, searchCodeTool, projectBrainTool } from "../tools/codebaseTools.js";
import { agentNotesTool, readNotes } from "../tools/notes.js";
import { createDelegateResearchTool, createDelegateBatchTool } from "./delegate.js";
import { context7Tool, firecrawlSearchTool, firecrawlScrapeTool, youtubeSearchTool, youtubeLearnTool, packageLookupTool } from "../tools/researchTools.js";
import { Context7Client, FirecrawlClient, YouTubeKnowledgeClient, PackageLookupClient, PersistentTtlCache } from "../research/clients.js";
import { fingerprintProject, type StackFingerprint } from "../context/fingerprint.js";
import { renderStackPacks } from "../context/stackpacks.js";
import { listSkills, renderSkillIndex, skillTool } from "../context/skills.js";
import { verifyTool } from "../context/verify.js";
import { HashEmbedder, OpenAIEmbedder, refreshSemanticIndex, semanticSearchTool, type Embedder, type SemanticIndex } from "../context/semantic.js";
import { importAdjacency } from "../context/retrieval.js";
import { indexProject } from "../context/indexer.js";
import { McpClient, type McpServerConfig } from "../mcp/client.js";

export interface AkosuaAgentBundle { agent: Agent; fingerprint: StackFingerprint; registry: ToolRegistry; terminals: Map<string, PersistentTerminal>; jobs: BackgroundJobManager; mcpConnected: string[]; mcpErrors: string[]; close(): Promise<void>; }

/** Assemble a fully-tooled Akosua agent for one workspace.
 * Tool availability is phase-gated by the registry (see agent/tools.ts):
 * Understand gets eyes (brain/list/search/view), Research gets Context7 ->
 * Firecrawl -> YouTube, Build gets hands (editor/terminal/checkpoint),
 * Verify gets run_verification. */
export async function buildAkosuaAgent(opts: {
  secrets: SecretStore; provider: ModelProvider; model: string; workspaceRoot: string;
  /** Host confirmation for destructive commands (permission tiers). */
  confirm?: (question: string) => Promise<boolean>;
  /** Host live-diagnostics (editor language servers via the IDE). Merged with
   * the built-in CLI oracle; either may contribute, neither is required. */
  hostDiagnostics?: (files: string[]) => Promise<string>;
  systemPrompt?: string;
  /** Per-role models (Planner/Editor/Reviewer). Reviewer, when set, gates
   * Build->Verify on the real diff. */
  routing?: ModelRouting;
  /** IDE builds set this: Plan completion pauses for human approval. */
  requirePlanApproval?: boolean;
  /** The user's standing instructions (Settings -> Akosua personal rules).
   * Appended after AKOSUA_RULES.md from the workspace root. This is the
   * "forgetting instructions" defence: rules live outside the chat, so they
   * survive every new conversation. */
  extraInstructions?: string;
  /** External MCP servers (stdio). Native research stays built-in; these are
   * the user's own plug-ins. Failed servers land in bundle.mcpErrors. */
  mcpServers?: McpServerConfig[];
}): Promise<AkosuaAgentBundle> {
  const fingerprint = await fingerprintProject(opts.workspaceRoot);
  const registry = new ToolRegistry();
  const terminals = new Map<string, PersistentTerminal>();
  const term = terminals;

  registry.register(projectBrainTool);
  registry.register(agentNotesTool);
  registry.register(skillTool as never);
  registry.register(listFilesTool);
  registry.register(searchCodeTool);
  registry.register(fileEditorTool);
  registry.register(terminalTool(terminals));
  const jobs = new BackgroundJobManager();
  registry.register(terminalJobsTool(jobs));
  registry.register(createGitCheckpointTool());
  await ensureAkosuaStateIgnored(opts.workspaceRoot).catch(() => undefined);
  const researchCache = await PersistentTtlCache.open(opts.workspaceRoot).catch(() => undefined);
  registry.register(context7Tool(new Context7Client(opts.secrets, researchCache)));
  registry.register(firecrawlSearchTool(new FirecrawlClient(opts.secrets, researchCache)));
  registry.register(firecrawlScrapeTool(new FirecrawlClient(opts.secrets, researchCache)));
  registry.register(youtubeSearchTool(new YouTubeKnowledgeClient(opts.secrets, researchCache)));
  registry.register(youtubeLearnTool(new YouTubeKnowledgeClient(opts.secrets, researchCache)));
  registry.register(packageLookupTool(new PackageLookupClient(researchCache)));
  // Sub-agent delegation: research subset only, planner provider/model.
  const researchSubset = [context7Tool(new Context7Client(opts.secrets, researchCache)), firecrawlSearchTool(new FirecrawlClient(opts.secrets, researchCache)), firecrawlScrapeTool(new FirecrawlClient(opts.secrets, researchCache)), youtubeSearchTool(new YouTubeKnowledgeClient(opts.secrets, researchCache)), youtubeLearnTool(new YouTubeKnowledgeClient(opts.secrets, researchCache)), packageLookupTool(new PackageLookupClient(researchCache)), searchCodeTool, projectBrainTool];
  registry.register(createDelegateResearchTool({ provider: opts.provider, model: opts.model, tools: researchSubset, workspaceRoot: opts.workspaceRoot }));
  registry.register(createDelegateBatchTool({ provider: opts.provider, model: opts.model, tools: researchSubset, workspaceRoot: opts.workspaceRoot }));
  // Retrieval quality ladder: neural embeddings when the user's OpenAI key
  // exists, deterministic local hashing otherwise. Selection is probed once;
  // a failed probe falls back permanently for this bundle (never mid-run).
  let embedder: Embedder = new HashEmbedder();
  try {
    const key = await opts.secrets.get(SecretKeys.openai);
    if (key) {
      const candidate = new OpenAIEmbedder(() => opts.secrets.get(SecretKeys.openai));
      await candidate.embed(["akosua embedder probe"]);
      embedder = candidate;
    }
  } catch { /* hash fallback — retrieval degrades, never dies */ }
  let semIdx: SemanticIndex | undefined;
  registry.register(semanticSearchTool(async () => (semIdx ??= await refreshSemanticIndex(opts.workspaceRoot, embedder)), embedder, async () => importAdjacency((await indexProject(opts.workspaceRoot)).files)));
  registry.register(verifyTool(fingerprint, async (command, cwd) => {
    if (!term.has("verify")) term.set("verify", new PersistentTerminal(undefined, cwd));
    return term.get("verify")!.run(command);
  }));

  const mcpClients: McpClient[] = [];
  const mcpConnected: string[] = [];
  const mcpErrors: string[] = [];
  for (const cfg of opts.mcpServers ?? []) {
    try {
      const { client, tools } = await McpClient.connect(cfg);
      mcpClients.push(client);
      for (const t of tools) registry.register(t);
      mcpConnected.push(cfg.name);
    } catch (e) { mcpErrors.push(`${cfg.name}: ${(e as Error).message}`); }
  }

  // Persistent rules: AKOSUA_RULES.md (project, committed if the user wants
  // the team-equivalent memory) then the user's global extra instructions.
  let systemPrompt = opts.systemPrompt ?? AKOSUA_SYSTEM_PROMPT;
  const rulesMd = await fs.readFile(path.join(opts.workspaceRoot, "AKOSUA_RULES.md"), "utf8").catch(() => "");
  // Ecosystem compat: AGENTS.md / .cursorrules are honoured too (marked as
  // imported, so AKOSUA_RULES.md keeps precedence in a conflict).
  const agentsMd = await fs.readFile(path.join(opts.workspaceRoot, "AGENTS.md"), "utf8").catch(() => "");
  const cursorRules = await fs.readFile(path.join(opts.workspaceRoot, ".cursorrules"), "utf8").catch(() => "");
  const rulesParts: string[] = [];
  if (rulesMd.trim()) rulesParts.push(`# Project rules (AKOSUA_RULES.md — treat as standing instructions, they outrank convenience):\n${rulesMd.slice(0, 8000)}`);
  if (agentsMd.trim()) rulesParts.push(`# Imported project rules (AGENTS.md — honoured; AKOSUA_RULES.md wins on conflict):\n${agentsMd.slice(0, 6000)}`);
  if (cursorRules.trim()) rulesParts.push(`# Imported rules (.cursorrules — honoured; AKOSUA_RULES.md wins on conflict):\n${cursorRules.slice(0, 4000)}`);
  if (opts.extraInstructions?.trim()) rulesParts.push(`# User's personal rules (standing instructions):\n${opts.extraInstructions.slice(0, 8000)}`);
  systemPrompt += renderStackPacks(fingerprint);
  systemPrompt += renderSkillIndex(await listSkills(opts.workspaceRoot).catch(() => []));
  if (rulesParts.length) systemPrompt += "\n\n" + rulesParts.join("\n\n");
  const notes = await readNotes(opts.workspaceRoot).catch(() => "");
  if (notes.trim()) systemPrompt += `\n\n# Project notebook (.akosua/NOTES.md — durable memory from earlier sessions; trust but verify against current code):\n${notes.slice(0, 6000)}`;
  const agent = new Agent(
    { provider: opts.provider, model: opts.model, systemPrompt, routing: opts.routing, requirePlanApproval: opts.requirePlanApproval ?? false, diagnostics: async (files: string[]) => {
      const [cli, host] = await Promise.all([
        quickDiagnostics(opts.workspaceRoot, files).catch(() => ""),
        opts.hostDiagnostics ? opts.hostDiagnostics(files).catch(() => "") : Promise.resolve(""),
      ]);
      return [host, cli].filter(Boolean).join("\n");
    }, confirm: opts.confirm, afterEdit: (files: string[]) => runFormatting(opts.workspaceRoot, files),
    },
    registry, opts.workspaceRoot);
  return { agent, fingerprint, registry, terminals, jobs, mcpConnected, mcpErrors,
    async close() {
      await jobs.closeAll().catch(() => undefined);
      for (const t of terminals.values()) await t.close(); terminals.clear();
      for (const c of mcpClients) await c.close().catch(() => undefined);
    } };
}
