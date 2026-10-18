import { promises as fs } from "node:fs";
import path from "node:path";
import type { SecretStore } from "../secrets.js";
import type { ModelProvider } from "../providers/types.js";
import { Agent, AKOSUA_SYSTEM_PROMPT, type ModelRouting } from "./loop.js";
import { ToolRegistry } from "./tools.js";
import { fileEditorTool } from "../tools/fileEditor.js";
import { terminalTool, PersistentTerminal } from "../tools/terminal.js";
import { createGitCheckpointTool, ensureAkosuaStateIgnored } from "../tools/git.js";
import { listFilesTool, searchCodeTool, projectBrainTool } from "../tools/codebaseTools.js";
import { context7Tool, firecrawlSearchTool, firecrawlScrapeTool, youtubeSearchTool, youtubeLearnTool, packageLookupTool } from "../tools/researchTools.js";
import { Context7Client, FirecrawlClient, YouTubeKnowledgeClient, PackageLookupClient, PersistentTtlCache } from "../research/clients.js";
import { fingerprintProject, type StackFingerprint } from "../context/fingerprint.js";
import { verifyTool } from "../context/verify.js";
import { HashEmbedder, buildSemanticIndex, semanticSearchTool, type SemanticIndex } from "../context/semantic.js";
import { McpClient, type McpServerConfig } from "../mcp/client.js";

export interface AkosuaAgentBundle { agent: Agent; fingerprint: StackFingerprint; registry: ToolRegistry; terminals: Map<string, PersistentTerminal>; mcpConnected: string[]; mcpErrors: string[]; close(): Promise<void>; }

/** Assemble a fully-tooled Akosua agent for one workspace.
 * Tool availability is phase-gated by the registry (see agent/tools.ts):
 * Understand gets eyes (brain/list/search/view), Research gets Context7 ->
 * Firecrawl -> YouTube, Build gets hands (editor/terminal/checkpoint),
 * Verify gets run_verification. */
export async function buildAkosuaAgent(opts: {
  secrets: SecretStore; provider: ModelProvider; model: string; workspaceRoot: string;
  systemPrompt?: string;
  /** Per-role models (Planner/Editor/Reviewer). Reviewer, when set, gates
   * Build->Verify on the real diff. */
  routing?: ModelRouting;
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
  registry.register(listFilesTool);
  registry.register(searchCodeTool);
  registry.register(fileEditorTool);
  registry.register(terminalTool(terminals));
  registry.register(createGitCheckpointTool());
  await ensureAkosuaStateIgnored(opts.workspaceRoot).catch(() => undefined);
  const researchCache = await PersistentTtlCache.open(opts.workspaceRoot).catch(() => undefined);
  registry.register(context7Tool(new Context7Client(opts.secrets, researchCache)));
  registry.register(firecrawlSearchTool(new FirecrawlClient(opts.secrets, researchCache)));
  registry.register(firecrawlScrapeTool(new FirecrawlClient(opts.secrets, researchCache)));
  registry.register(youtubeSearchTool(new YouTubeKnowledgeClient(opts.secrets, researchCache)));
  registry.register(youtubeLearnTool(new YouTubeKnowledgeClient(opts.secrets, researchCache)));
  registry.register(packageLookupTool(new PackageLookupClient(researchCache)));
  const embedder = new HashEmbedder();
  let semIdx: SemanticIndex | undefined;
  registry.register(semanticSearchTool(async () => (semIdx ??= await buildSemanticIndex(opts.workspaceRoot, embedder)), embedder));
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
  const rulesParts: string[] = [];
  if (rulesMd.trim()) rulesParts.push(`# Project rules (AKOSUA_RULES.md — treat as standing instructions, they outrank convenience):\n${rulesMd.slice(0, 8000)}`);
  if (opts.extraInstructions?.trim()) rulesParts.push(`# User's personal rules (standing instructions):\n${opts.extraInstructions.slice(0, 8000)}`);
  if (rulesParts.length) systemPrompt += "\n\n" + rulesParts.join("\n\n");
  const agent = new Agent(
    { provider: opts.provider, model: opts.model, systemPrompt, routing: opts.routing },
    registry, opts.workspaceRoot);
  return { agent, fingerprint, registry, terminals, mcpConnected, mcpErrors,
    async close() {
      for (const t of terminals.values()) await t.close(); terminals.clear();
      for (const c of mcpClients) await c.close().catch(() => undefined);
    } };
}
