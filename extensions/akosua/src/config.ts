/** Pure configuration logic (no vscode imports) so it is unit-testable. */
export type ProviderId = "anthropic" | "openai" | "firecrawl" | "context7" | "transcriptApi";

export interface ProviderSpec {
  id: ProviderId;
  label: string;
  /** SecretStorage key. NEVER a settings.json value: secrets do not belong in settings. */
  secretKey: string;
  settingsCommand: string;
  /** Lightweight authenticated endpoint used by "Test connection". */
  testUrl: string;
  testHeaders: (key: string) => Record<string, string>;
  docsHint: string;
}

export const PROVIDERS: ProviderSpec[] = [
  { id: "anthropic", label: "Claude (Anthropic)", secretKey: "akosua.provider.anthropic",
    settingsCommand: "akosua.setClaudeKey", testUrl: "https://api.anthropic.com/v1/models",
    testHeaders: k => ({ "x-api-key": k, "anthropic-version": "2023-06-01" }),
    docsHint: "Planner / reviewer brain (console.anthropic.com)" },
  { id: "openai", label: "OpenAI", secretKey: "akosua.provider.openai",
    settingsCommand: "akosua.setOpenAIKey", testUrl: "https://api.openai.com/v1/models",
    testHeaders: k => ({ authorization: `Bearer ${k}` }),
    docsHint: "Cross-review + edits (platform.openai.com)" },
  { id: "firecrawl", label: "Firecrawl", secretKey: "akosua.research.firecrawl",
    settingsCommand: "akosua.setFirecrawlKey", testUrl: "https://api.firecrawl.dev/v1/team/credit-usage",
    testHeaders: k => ({ authorization: `Bearer ${k}` }),
    docsHint: "Online research: implementations, solutions, docs fallback (firecrawl.dev)" },
  { id: "context7", label: "Context7", secretKey: "akosua.research.context7",
    settingsCommand: "akosua.setContext7Key", testUrl: "https://context7.com/api/v2/search?query=nestjs",
    testHeaders: k => ({ authorization: `Bearer ${k}` }),
    docsHint: "Primary version-pinned docs lookup (context7.com)" },
  { id: "transcriptApi", label: "YouTube (TranscriptAPI)", secretKey: "akosua.research.transcriptApi",
    settingsCommand: "akosua.setTranscriptApiKey", testUrl: "https://transcriptapi.com/api/v2/youtube/info?video_url=Xf9rHPNBMyQ",
    testHeaders: k => ({ authorization: `Bearer ${k}` }),
    docsHint: "YouTube knowledge: search + transcripts, ideas only (transcriptapi.com)" },
];

export const specFor = (id: ProviderId): ProviderSpec => PROVIDERS.find(p => p.id === id)!;

/** Which provider serves each agent phase (user-changeable settings). */
export interface PhaseRouting { planner: ProviderId; editor: ProviderId; reviewer: ProviderId; }
export const DEFAULT_ROUTING: PhaseRouting = { planner: "anthropic", editor: "anthropic", reviewer: "openai" };

export function maskedStatus(hasKey: boolean): string { return hasKey ? "● key saved" : "○ no key"; }

/** External MCP servers from settings (akosua.mcpServers). Users write JSON
 * in settings; anything malformed is reported, never silently dropped, and
 * secrets belong in each server's env block (still settings, user's choice)
 * — Akosua itself stores none of it. allowBuild defaults FALSE: external
 * tools stay out of the Build phase unless the user explicitly opts in. */
export interface McpServerSetting { name: string; command: string; args?: string[]; env?: Record<string, string>; allowBuild?: boolean; }
export function parseMcpServers(raw: unknown): { servers: McpServerSetting[]; errors: string[] } {
  if (raw === undefined || raw === null) return { servers: [], errors: [] };
  if (!Array.isArray(raw)) return { servers: [], errors: ["akosua.mcpServers must be an array of {name, command, args?, env?, allowBuild?}"] };
  const servers: McpServerSetting[] = []; const errors: string[] = [];
  raw.forEach((e, i) => {
    const o = e as Record<string, unknown>;
    if (!o || typeof o.name !== "string" || typeof o.command !== "string")
      errors.push(`akosua.mcpServers[${i}] needs string "name" and "command" — skipped`);
    else servers.push({ name: o.name, command: o.command,
      args: Array.isArray(o.args) ? o.args.map(String) : undefined,
      env: o.env && typeof o.env === "object" ? Object.fromEntries(Object.entries(o.env as object).map(([k, v]) => [k, String(v)])) : undefined,
      allowBuild: o.allowBuild === true });
  });
  return { servers, errors };
}
