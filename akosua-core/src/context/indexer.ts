import { promises as fs } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import type { StackFingerprint } from "./fingerprint.js";

export interface RouteInfo { method: string; path: string; file: string; }
export interface DtoInfo { name: string; file: string; fields: { name: string; type: string }[]; }
export interface ConsumerInfo { kind: string; path: string; file: string; }
export interface FileIndex {
  path: string; language: "ts" | "dart" | "py" | "other"; hash: string; size: number;
  symbols: string[]; imports: string[]; routes: RouteInfo[]; events: string[];
  dtos: DtoInfo[]; consumers: ConsumerInfo[];
}
export interface ProjectIndex {
  version: 1; root: string; indexedAt: string;
  files: FileIndex[];
  contracts: { http: RouteInfo[]; events: string[]; dtos: DtoInfo[]; consumers: ConsumerInfo[] };
}

const IGNORE = new Set(["node_modules", ".git", "dist", "build", ".next", ".akosua", ".dart_tool", "__pycache__", ".venv"]);
const EXT_LANG: Record<string, FileIndex["language"]> = { ".ts": "ts", ".tsx": "ts", ".js": "ts", ".dart": "dart", ".py": "py", ".prisma": "other" };

export async function* walk(root: string): AsyncIterable<string> {
  let entries; try { entries = await fs.readdir(root, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    if (e.name.startsWith(".") || IGNORE.has(e.name)) continue;
    const p = path.join(root, e.name);
    if (e.isDirectory()) yield* walk(p);
    else if (EXT_LANG[path.extname(e.name)]) yield p;
  }
}

/** Lightweight structural extraction (regex-based v1; tree-sitter is the
 * planned upgrade). Captures what the agent needs to navigate truthfully:
 * symbols, imports, HTTP routes (Nest decorators + Next handlers) and
 * microservice event patterns (NATS/Kafka/RabbitMQ/Redis subjects). */
export function extractStructure(rel: string, content: string, lang: FileIndex["language"]): Omit<FileIndex, "path" | "hash" | "size" | "language"> {
  const symbols: string[] = [], imports: string[] = [], routes: RouteInfo[] = [], events: string[] = [];
  const dtos: DtoInfo[] = [], consumers: ConsumerInfo[] = [];
  // TS class/interface DTO shapes (fields are the contract other services/apps depend on)
  if (lang === "ts") {
    for (const m of content.matchAll(/(?:export\s+)?(?:class|interface)\s+([A-Za-z0-9_]+)(?:\s+extends\s+[^{]+)?\s*\{([\s\S]*?)\n\}/g)) {
      const fields = [...m[2].matchAll(/^\s*(?:readonly\s+)?([A-Za-z0-9_]+)(\?)?:\s*([^;,\n]+)/gm)]
        .map(f => ({ name: f[1] + (f[2] ?? ""), type: f[3].trim() }));
      if (fields.length) dtos.push({ name: m[1], file: rel, fields });
    }
    // client-side API consumers: fetch()/axios/http calls with URL strings
    for (const m of content.matchAll(/(fetch|axios\.(?:get|post|put|patch|delete)|http\.(?:get|post|put|patch|delete))\s*\(\s*[`'"]([^`'"]*)[`'"]/g)) {
      const url = m[2]; const pathOnly = url.replace(/^https?:\/\/[^/]+/, "");
      if (pathOnly.startsWith("/")) consumers.push({ kind: m[1], path: pathOnly, file: rel });
    }
  }
  if (lang === "other" && rel.endsWith(".prisma")) {
    for (const m of content.matchAll(/model\s+([A-Za-z0-9_]+)\s*\{([^}]*)\}/g)) {
      const fields = [...m[2].matchAll(/([A-Za-z_][A-Za-z0-9_]*)\s+(Int|Float|String|Boolean|DateTime|Json|Decimal|BigInt)(\[\]|\?)?/g)]
        .map(f => ({ name: f[1], type: f[2] + (f[3] ?? "") }));
      if (fields.length) dtos.push({ name: `Prisma:${m[1]}`, file: rel, fields });
    }
  }
  for (const m of content.matchAll(/^\s*import\s+(?:[^'"]*from\s+)?['"]([^'"]+)['"]/gm)) imports.push(m[1]);
  for (const m of content.matchAll(/^\s*from\s+['"]([^'"]+)['"]/gm)) imports.push(m[1]); // python
  if (lang === "ts") {
    for (const m of content.matchAll(/export\s+(?:default\s+)?(?:abstract\s+)?(class|interface|enum|function|const|type)\s+([A-Za-z0-9_]+)/g)) symbols.push(`${m[1]} ${m[2]}`);
    const ctrl = /@Controller\s*\(\s*(?:'([^']*)'|"([^"]*)")?\s*\)/.exec(content);
    const prefix = ctrl ? (ctrl[1] ?? ctrl[2] ?? "").replace(/^\/?/, "/").replace(/\/$/, "") : "";
    if (ctrl) routes.push({ method: "CONTROLLER", path: prefix || "/", file: rel });
    for (const m of content.matchAll(/@(Get|Post|Put|Patch|Delete)\s*\(\s*(?:'([^']*)'|"([^"]*)")?\s*\)/g)) {
      const sub = (m[2] ?? m[3] ?? "").replace(/^\/?/, "/").replace(/\/$/, "");
      routes.push({ method: m[1].toUpperCase(), path: (prefix + (sub === "/" ? "" : sub)) || "/", file: rel });
    }
    for (const m of content.matchAll(/@(EventPattern|MessagePattern)\s*\(\s*(?:'([^']*)'|"([^"]*)")/g)) events.push(`${m[1]}:${m[2] ?? m[3]}`);
    for (const m of content.matchAll(/export\s+async\s+function\s+(GET|POST|PUT|PATCH|DELETE)\b/g)) routes.push({ method: m[1], path: "(next route handler)", file: rel });
  } else if (lang === "dart") {
    for (const m of content.matchAll(/class\s+([A-Za-z0-9_]+)\s+extends\s+(StatelessWidget|StatefulWidget|ConsumerWidget|ConsumerStatefulWidget|Notifier|AsyncNotifier|Provider)/g)) symbols.push(`${m[2]} ${m[1]}`);
    for (const m of content.matchAll(/(?:final|const)\s+([A-Za-z0-9_]+Provider)\s*=/g)) symbols.push(`Riverpod ${m[1]}`);
    for (const m of content.matchAll(/class\s+([A-Za-z0-9_]+)/g)) if (!symbols.some(s => s.endsWith(m[1]))) symbols.push(`class ${m[1]}`);
  } else if (lang === "py") {
    for (const m of content.matchAll(/^(?:class|def|async def)\s+([A-Za-z0-9_]+)/gm)) symbols.push(m[0].trim());
  }
  return { symbols, imports: [...new Set(imports)], routes, events: [...new Set(events)], dtos, consumers };
}

/** Index a project. With a previous index, unchanged files (sha256 match)
 * are reused untouched — incremental indexing (Merkle idea, file level). */
export async function indexProject(root: string, previous?: ProjectIndex): Promise<ProjectIndex> {
  const prev = new Map((previous?.files ?? []).map(f => [f.path, f]));
  const files: FileIndex[] = [];
  for await (const abs of walk(root)) {
    const rel = path.relative(root, abs);
    const raw = await fs.readFile(abs);
    const hash = createHash("sha256").update(raw).digest("hex");
    const old = prev.get(rel);
    if (old && old.hash === hash) { files.push(old); continue; }
    const lang = EXT_LANG[path.extname(abs)] ?? "other";
    files.push({ path: rel, language: lang, hash, size: raw.length, ...extractStructure(rel, raw.toString("utf8"), lang) });
  }
  files.sort((a, b) => a.path.localeCompare(b.path));
  return { version: 1, root, indexedAt: new Date().toISOString(), files,
    contracts: { http: files.flatMap(f => f.routes), events: [...new Set(files.flatMap(f => f.events))],
      dtos: files.flatMap(f => f.dtos), consumers: files.flatMap(f => f.consumers) } };
}

export async function saveIndex(root: string, idx: ProjectIndex) {
  const dir = path.join(root, ".akosua"); await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, "index.json"), JSON.stringify(idx, null, 2));
}
export async function loadIndex(root: string): Promise<ProjectIndex | undefined> {
  try { return JSON.parse(await fs.readFile(path.join(root, ".akosua/index.json"), "utf8")); } catch { return undefined; }
}

export function renderBrainV2(fp: StackFingerprint, idx: ProjectIndex): string {
  const header = `# Project Brain (Akosua)\n\n- Root: ${fp.root}\n- Shape: ${fp.shape}\n` +
    `- Backend: ${fp.backend ? `${fp.backend.framework}${fp.backend.adapter ? ` (${fp.backend.adapter})` : ""}${fp.backend.transports.length ? ` transports=${fp.backend.transports.join("/")}` : ""}${fp.backend.orm ? ` orm=${fp.backend.orm}` : ""}` : "-"}\n` +
    `- Web: ${fp.web?.framework ?? "-"} | Mobile: ${fp.mobile ? `${fp.mobile.framework} (${fp.mobile.state ?? "?"})` : "-"} | Python: ${fp.python ? "yes" : "no"}\n` +
    `- Verify: ${fp.verifyCommands.join(" · ") || "-"}\n- Indexed: ${idx.files.length} files @ ${idx.indexedAt}\n`;
  const dtoLines = idx.contracts.dtos.map(d => `- ${d.name} (${d.file}): ${d.fields.map(f => `${f.name}: ${f.type}`).join(", ")}`);
  const consumerLines = idx.contracts.consumers.map(c => `- ${c.kind} -> ${c.path}  (${c.file})`);
  const contracts = `\n## Contract map\n### HTTP\n${idx.contracts.http.map(r => `- ${r.method} ${r.path}  (${r.file})`).join("\n") || "- none detected"}\n### Events/messages\n${idx.contracts.events.map(e => `- ${e}`).join("\n") || "- none detected"}\n### DTOs / schemas (payload shapes — changing these ripples to consumers)\n${dtoLines.join("\n") || "- none detected"}\n### API consumers (who calls what)\n${consumerLines.join("\n") || "- none detected"}\n`;
  // Budgeted render: contract map is the high-value evidence; the file list
  // is a MAP, not a dump (JIT retrieval: agents fetch details via tools).
  // Large repos get the first 250 files + a stated remainder, never a
  // multi-hundred-KB system-prompt slab.
  const MAX_FILES = 250;
  const shown = idx.files.slice(0, MAX_FILES);
  const remainder = idx.files.length - shown.length;
  const files = `\n## Files (map — use project_brain/search_code/semantic_search for detail)\n${shown.map(f => `- ${f.path} [${f.language}] ${f.symbols.slice(0, 6).join(", ") || ""}`).join("\n")}${remainder > 0 ? `\n- …and ${remainder} more files (not listed; search for them)` : ""}\n`;
  const cap = (s: string, n: number) => s.length > n ? s.slice(0, n) + "\n…[Brain section capped]" : s;
  return header + cap(contracts, 8000) + files;
}
