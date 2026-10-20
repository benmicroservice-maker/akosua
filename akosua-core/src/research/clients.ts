import type { SecretStore } from "../secrets.js";
import { SecretKeys } from "../secrets.js";
import type { FetchLike } from "../providers/types.js";

/** Simple TTL cache — Research gets faster/cheaper, invalidation by key change (e.g. library@version). */
export class TtlCache {
  private m = new Map<string, { at: number; value: string }>();
  constructor(protected ttlMs = 24 * 3600 * 1000) {}
  get(k: string) { const e = this.m.get(k); return e && Date.now() - e.at < this.ttlMs ? e.value : undefined; }
  set(k: string, v: string) { this.m.set(k, { at: Date.now(), value: v }); }
}

/** Context7 NATIVE (not MCP): version-pinned docs lookup — Research rung #2. */
export class Context7Client {
  constructor(private secrets: SecretStore, private cache = new TtlCache(), private fetchFn: FetchLike = fetch as never) {}
  async docs(library: string, version?: string, topic = ""): Promise<string> {
    const cacheKey = `context7:${library}@${version ?? "latest"}:${topic}`;
    const hit = this.cache.get(cacheKey); if (hit) return hit;
    const key = await this.secrets.get(SecretKeys.context7);
    const headers: Record<string, string> = key ? { authorization: `Bearer ${key}` } : {};
    // 1) resolve library id
    const search = await this.fetchFn(`https://context7.com/api/v2/search?query=${encodeURIComponent(library)}`, { headers });
    if (!search.ok) throw new Error(`Context7 search ${search.status}: ${await search.text()}`);
    const results: any = await search.json();
    const id = results?.results?.[0]?.id ?? results?.[0]?.id;
    if (!id) return `Context7: no library found for "${library}". Fall back to Firecrawl on the official docs site.`;
    const v = version ? `/${version}` : "";
    const urlFor = (suffix: string) => `https://context7.com/api/v2/context?libraryId=${encodeURIComponent(id + suffix)}&query=${encodeURIComponent(topic || library)}`;
    let res = await this.fetchFn(urlFor(v), { headers });
    let versionNote = "";
    if (!res.ok && version) {
      // Live lesson (2026-10-20): projects pin versions Context7 does not
      // carry under that exact string (Expo "57.0.0" vs sdk-57 branches) and
      // the hard 404 wasted the lookup. Retry unpinned and SAY SO — latest
      // docs labelled as such beat no docs, silently-wrong docs do not.
      const errBody = await res.text();
      if (/version_not_found/i.test(errBody)) {
        const retry = await this.fetchFn(urlFor(""), { headers });
        if (retry.ok) { res = retry; versionNote = `NOTE: Context7 has no version "${version}" for ${library}; showing UNPINNED (latest) docs — verify version-sensitive APIs against the project's installed types.\n`; }
        else throw new Error(`Context7 context ${res.status}: ${errBody}`);
      } else throw new Error(`Context7 context ${res.status}: ${errBody}`);
    }
    if (!res.ok) throw new Error(`Context7 context ${res.status}: ${await res.text()}`);
    const out = `Source: Context7 (${library}${version ? "@" + version : ""})\n` + versionNote + await res.text();
    this.cache.set(cacheKey, out); return out;
  }
}

/** Firecrawl NATIVE: online research — docs fallback + implementations/solutions (Stack Overflow etc.). */
export class FirecrawlClient {
  constructor(private secrets: SecretStore, private cache = new TtlCache(), private fetchFn: FetchLike = fetch as never) {}
  private async headers() {
    const key = await this.secrets.get(SecretKeys.firecrawl);
    if (!key) throw new Error("Firecrawl API key not set (Settings -> Providers & Keys)");
    return { "content-type": "application/json", authorization: `Bearer ${key}` };
  }
  async scrape(url: string): Promise<string> {
    const hit = this.cache.get("fc:" + url); if (hit) return hit;
    const res = await this.fetchFn("https://api.firecrawl.dev/v1/scrape", {
      method: "POST", headers: await this.headers(), body: JSON.stringify({ url, formats: ["markdown"] }) });
    if (!res.ok) throw new Error(`Firecrawl scrape ${res.status}: ${await res.text()}`);
    const data: any = await res.json();
    const out = `Source: Firecrawl scrape of ${url}\n` + (data?.data?.markdown ?? JSON.stringify(data));
    this.cache.set("fc:" + url, out); return out;
  }
  async search(query: string, limit = 5): Promise<string> {
    const res = await this.fetchFn("https://api.firecrawl.dev/v1/search", {
      method: "POST", headers: await this.headers(), body: JSON.stringify({ query, limit }) });
    if (!res.ok) throw new Error(`Firecrawl search ${res.status}: ${await res.text()}`);
    const data: any = await res.json();
    const items = (data?.data ?? []).map((r: any, i: number) => `${i + 1}. ${r.title ?? ""} — ${r.url}\n${r.description ?? r.markdown ?? ""}`).join("\n\n");
    return `Source: Firecrawl web search "${query}" (community/official web — verify before applying)\n${items}`;
  }
}

/** YouTube Knowledge NATIVE via TranscriptAPI: search -> timestamped transcript -> CITED ideas.
 * Truth rule: video content is a lead, never proof. Verify against code/docs/tests before use. */
export class YouTubeKnowledgeClient {
  constructor(private secrets: SecretStore, private cache = new TtlCache(), private fetchFn: FetchLike = fetch as never) {}
  private async headers() {
    const key = await this.secrets.get(SecretKeys.transcriptApi);
    if (!key) throw new Error("TranscriptAPI key not set (Settings -> Providers & Keys)");
    return { authorization: `Bearer ${key}` };
  }
  async search(query: string): Promise<string> {
    // TranscriptAPI search takes `q` (verified live 2026-10-18 against the
    // current API docs — `query` returns 400 "Either 'q' or 'continuation' is required").
    const res = await this.fetchFn(`https://transcriptapi.com/api/v2/youtube/search?q=${encodeURIComponent(query)}&type=video`, { headers: await this.headers() });
    if (!res.ok) throw new Error(`YouTube search ${res.status}: ${await res.text()}`);
    const data: any = await res.json();
    const results = Array.isArray(data?.results) ? data.results : [];
    if (!results.length) return `Source: YouTube search "${query}"\n` + JSON.stringify(data).slice(0, 6000);
    const lines = results.slice(0, 10).map((r: any, i: number) =>
      `${i + 1}. ${r.title ?? "(untitled)"} — https://www.youtube.com/watch?v=${r.videoId} (${r.channelTitle ?? r.channelName ?? "unknown channel"}${r.lengthText ? ", " + r.lengthText : ""}${r.viewCountText ? ", " + r.viewCountText : ""})`);
    return `Source: YouTube search "${query}" — IDEAS ONLY, use youtube_learn on a result then verify.\n` + lines.join("\n");
  }
  async learn(videoUrlOrId: string, maxChars = 24000): Promise<string> {
    const hit = this.cache.get("yt:" + videoUrlOrId); if (hit) return hit;
    const res = await this.fetchFn(`https://transcriptapi.com/api/v2/youtube/transcript?video_url=${encodeURIComponent(videoUrlOrId)}&format=text&include_timestamp=true&send_metadata=true`, { headers: await this.headers() });
    if (!res.ok) throw new Error(`YouTube transcript ${res.status}: ${await res.text()}`);
    const data: any = await res.json();
    const title = data?.metadata?.title ?? videoUrlOrId;
    const out = `Source: YouTube video "${title}" (${videoUrlOrId}) — IDEAS ONLY, verify before applying.\n` +
      String(data?.transcript ?? data).slice(0, maxChars);
    this.cache.set("yt:" + videoUrlOrId, out); return out;
  }
}


/** Package/docs/changelog lookup NATIVE: public registries, no key needed.
 * Answers "what is the current version, where are the docs/repo/changelog"
 * from registry FACTS only — links the registry did not provide are labelled
 * CANDIDATE (unverified), never presented as fact. Use before adding or
 * upgrading any dependency; compare against the project lockfile. */
export type Ecosystem = "npm" | "pub" | "pypi";
export class PackageLookupClient {
  constructor(private cache = new TtlCache(), private fetchFn: FetchLike = fetch as never) {}
  async lookup(pkg: string, ecosystem: Ecosystem | "auto" = "auto"): Promise<string> {
    const cacheKey = `pkg:${ecosystem}:${pkg}`;
    const hit = this.cache.get(cacheKey); if (hit) return hit;
    const order: Ecosystem[] = ecosystem === "auto" ? ["npm", "pub", "pypi"] : [ecosystem];
    let lastErr = "";
    for (const eco of order) {
      try {
        const out = eco === "npm" ? await this.npm(pkg) : eco === "pub" ? await this.pub(pkg) : await this.pypi(pkg);
        this.cache.set(cacheKey, out); return out;
      } catch (e) { lastErr = (e as Error).message; if (ecosystem !== "auto") throw e; }
    }
    return `Source: package registries\nNo package "${pkg}" found (tried ${order.join(", ")}). Last error: ${lastErr}. Check the exact package name in the project lockfile — do not guess a substitute.`;
  }
  private async getJson(url: string): Promise<any> {
    const res = await this.fetchFn(url, {});
    if (!res.ok) throw new Error(`${url} -> HTTP ${res.status}`);
    return res.json();
  }
  private async npm(pkg: string): Promise<string> {
    const d = await this.getJson(`https://registry.npmjs.org/${encodeURIComponent(pkg)}`);
    const latest = d?.["dist-tags"]?.latest;
    const v = latest ? d?.versions?.[latest] : undefined;
    if (!latest || !v) throw new Error("npm: malformed registry response");
    const repo = String(v.repository?.url ?? "").replace(/^git\+/, "").replace(/\.git$/, "");
    const times = Object.entries<any>(d.time ?? {}).filter(([k]) => k !== "created" && k !== "modified")
      .sort((a, b) => String(b[1]).localeCompare(String(a[1]))).slice(0, 5)
      .map(([ver, at]) => `${ver} (${String(at).slice(0, 10)})`).join(", ");
    return [`Source: npm registry (${pkg}) — registry facts`,
      `Latest: ${latest} (published ${String(d.time?.[latest] ?? "?").slice(0, 10)})`,
      `Description: ${v.description ?? "(none)"}`,
      `Homepage: ${v.homepage ?? "(not provided)"}`,
      `Repository: ${repo || "(not provided)"}`,
      `Recent versions: ${times || "(none)"}`,
      repo ? `Changelog (CANDIDATE, unverified): ${repo}/blob/HEAD/CHANGELOG.md — confirm by scraping it with firecrawl_scrape.` : `Changelog: not derivable from registry (no repository URL).`,
      `Compare against the project lockfile before proposing any upgrade.`].join("\n");
  }
  private async pub(pkg: string): Promise<string> {
    const d = await this.getJson(`https://pub.dev/api/packages/${encodeURIComponent(pkg)}`);
    const latest = d?.latest?.version; const spec = d?.latest?.pubspec ?? {};
    if (!latest) throw new Error("pub: malformed registry response");
    const repo = spec.repository ?? spec.homepage ?? "";
    return [`Source: pub.dev registry (${pkg}) — registry facts`,
      `Latest: ${latest}`,
      `Description: ${spec.description ?? "(none)"}`,
      `Homepage: ${spec.homepage ?? "(not provided)"}`,
      `Repository: ${repo || "(not provided)"}`,
      `Documentation: ${spec.documentation ?? "(not provided)"}`,
      repo ? `Changelog (CANDIDATE, unverified): ${String(repo).replace(/\/$/, "")}/blob/HEAD/CHANGELOG.md — confirm by scraping it with firecrawl_scrape.` : `Changelog: not derivable from registry (no repository URL).`,
      `Compare against pubspec.lock before proposing any upgrade.`].join("\n");
  }
  private async pypi(pkg: string): Promise<string> {
    const d = await this.getJson(`https://pypi.org/pypi/${encodeURIComponent(pkg)}/json`);
    const info = d?.info ?? {};
    if (!info.version) throw new Error("pypi: malformed registry response");
    const urls = info.project_urls ?? {};
    const changelog = urls.Changelog ?? urls.Changes ?? urls.History;
    return [`Source: PyPI registry (${pkg}) — registry facts`,
      `Latest: ${info.version}`,
      `Summary: ${info.summary ?? "(none)"}`,
      `Homepage: ${info.home_page ?? urls.Homepage ?? "(not provided)"}`,
      `Repository: ${urls.Source ?? urls.Repository ?? urls.Code ?? "(not provided)"}`,
      `Documentation: ${urls.Documentation ?? urls.Docs ?? "(not provided)"}`,
      changelog ? `Changelog (registry-provided): ${changelog}` : `Changelog: not provided by the registry — check the repository.`,
      `Requires-Python: ${info.requires_python ?? "(unspecified)"}`,
      `Compare against requirements/pyproject lock before proposing any upgrade.`].join("\n");
  }
}

/** Persistent research cache: survives restarts, lives in the workspace at
 * .akosua/research-cache.json (Akosua's own folder, excluded from indexing).
 * Hardening vs the in-memory cache: TTL expiry + LRU-style eviction at
 * maxEntries + explicit invalidation by key prefix (e.g. when a lockfile
 * changes, drop `context7:` entries for the old version — keys already embed
 * library@version, and invalidate() is the belt-and-braces reset). */
import { promises as fs } from "node:fs";
import path from "node:path";
export class PersistentTtlCache extends TtlCache {
  private file: string; private maxEntries: number; private dirty = false;
  private data = new Map<string, { at: number; value: string }>();
  private constructor(file: string, ttlMs: number, maxEntries: number) { super(ttlMs); this.file = file; this.maxEntries = maxEntries; }
  static async open(workspaceRoot: string, ttlMs = 7 * 24 * 3600 * 1000, maxEntries = 500): Promise<PersistentTtlCache> {
    const c = new PersistentTtlCache(path.join(workspaceRoot, ".akosua", "research-cache.json"), ttlMs, maxEntries);
    try { const raw = JSON.parse(await fs.readFile(c.file, "utf8")); for (const [k, v] of Object.entries<any>(raw)) c.data.set(k, v); } catch { /* first run */ }
    return c;
  }
  override get(k: string) {
    const e = this.data.get(k);
    if (!e) return undefined;
    if (Date.now() - e.at >= this.ttlMs) { this.data.delete(k); return undefined; }
    return e.value;
  }
  override set(k: string, v: string) {
    this.data.delete(k); this.data.set(k, { at: Date.now(), value: v });
    while (this.data.size > this.maxEntries) { const first = this.data.keys().next().value as string; this.data.delete(first); }
    this.dirty = true; void this.flush();
  }
  invalidate(prefix: string) { for (const k of [...this.data.keys()]) if (k.startsWith(prefix)) this.data.delete(k); this.dirty = true; void this.flush(); }
  private flushing: Promise<void> | undefined;
  async flush(): Promise<void> {
    if (this.flushing) return this.flushing;
    if (!this.dirty) return;
    this.dirty = false;
    this.flushing = (async () => {
      await fs.mkdir(path.dirname(this.file), { recursive: true });
      await fs.writeFile(this.file, JSON.stringify(Object.fromEntries(this.data)));
    })().finally(() => { this.flushing = undefined; });
    return this.flushing;
  }
}
