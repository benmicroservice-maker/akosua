import type { Tool } from "../agent/tools.js";
import type { Context7Client, FirecrawlClient, YouTubeKnowledgeClient } from "../research/clients.js";

export const context7Tool = (c: Context7Client): Tool => ({
  definition: { name: "context7_docs", description: "Look up CURRENT, version-specific documentation for a library/framework. This is the PRIMARY docs tool — use it before relying on memory for any library API. Pass the exact version from the project's lockfile when known.",
    parameters: { type: "object", required: ["library"], properties: { library: { type: "string" }, version: { type: "string" }, topic: { type: "string" } } } },
  phases: ["research", "understand"],
  run: async a => c.docs(String(a.library), a.version ? String(a.version) : undefined, String(a.topic ?? "")),
});
export const firecrawlSearchTool = (c: FirecrawlClient): Tool => ({
  definition: { name: "firecrawl_search", description: "Search the web for implementations, examples and solutions (including Stack Overflow). Use for HOW others solved it online, and for docs only when Context7 falls short. Results are leads — verify before applying.",
    parameters: { type: "object", required: ["query"], properties: { query: { type: "string" } } } },
  phases: ["research"],
  run: async a => c.search(String(a.query)),
});
export const firecrawlScrapeTool = (c: FirecrawlClient): Tool => ({
  definition: { name: "firecrawl_scrape", description: "Scrape one specific URL to markdown (official docs page, guide, changelog, README). Use after search, or when Context7 lacks the library.",
    parameters: { type: "object", required: ["url"], properties: { url: { type: "string" } } } },
  phases: ["research"],
  run: async a => c.scrape(String(a.url)),
});
export const youtubeSearchTool = (c: YouTubeKnowledgeClient): Tool => ({
  definition: { name: "youtube_search", description: "Search YouTube for solution/tutorial videos. Then use youtube_learn on a result to read its transcript. Video knowledge is IDEAS ONLY — verify against code/docs/tests before applying.",
    parameters: { type: "object", required: ["query"], properties: { query: { type: "string" } } } },
  phases: ["research"],
  run: async a => c.search(String(a.query)),
});
export const youtubeLearnTool = (c: YouTubeKnowledgeClient): Tool => ({
  definition: { name: "youtube_learn", description: "Read a YouTube video's timestamped transcript to extract ideas/approaches. Cite video + timestamp in your plan if you use an idea. Verify every idea before applying it.",
    parameters: { type: "object", required: ["video"], properties: { video: { type: "string", description: "Video URL or ID" } } } },
  phases: ["research"],
  run: async a => c.learn(String(a.video)),
});
import type { PackageLookupClient } from "../research/clients.js";
export const packageLookupTool = (c: PackageLookupClient): Tool => ({
  definition: { name: "package_lookup", description: "Look up a package in its public registry (npm / pub.dev / PyPI): current latest version + publish date, description, homepage, repository, documentation and changelog location. Use BEFORE adding or upgrading a dependency, and compare the result against the project's lockfile — never propose a version from memory. Registry facts only; changelog links labelled CANDIDATE must be confirmed with firecrawl_scrape.",
    parameters: { type: "object", required: ["package"], properties: { package: { type: "string", description: "Exact package name, e.g. @nestjs/platform-fastify, flutter_riverpod, fastapi" }, ecosystem: { type: "string", enum: ["auto", "npm", "pub", "pypi"], description: "Default auto (tries npm, pub, PyPI)" } } } },
  phases: ["understand", "research"],
  run: async a => c.lookup(String(a.package), (a.ecosystem as never) ?? "auto"),
});
