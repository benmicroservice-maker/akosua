import { promises as fs } from "node:fs";
import path from "node:path";

export interface StackFingerprint {
  root: string;
  shape: "monorepo" | "polyrepo-workspace" | "monolith" | "unknown";
  backend?: { framework: "nestjs" | "express" | "fastify-standalone"; adapter?: "fastify" | "express"; transports: string[]; orm?: "prisma" | "typeorm" };
  web?: { framework: "nextjs" | "react-vite" | "other" };
  mobile?: { framework: "flutter" | "react-native"; state?: "riverpod" | "bloc" | "other" };
  /** How Flutter was detected when no pubspec was found (honesty over guessing). */
  flutterDetectedFrom?: string;
  /** Code-file census by language (files, not bytes): the primary-language truth. */
  languageCounts?: Record<string, number>;
  /** Workspace-relative dir of the Flutter app ("." = root). */
  flutterDir?: string;
  python?: boolean;
  testCommands: string[]; verifyCommands: string[];
}

const read = async (p: string) => { try { return await fs.readFile(p, "utf8"); } catch { return ""; } };
const has = async (p: string) => { try { await fs.access(p); return true; } catch { return false; } };

/** Fingerprint a project from EVIDENCE (Detect, never assume — Spec Round 3).
 * Reads manifests/configs only; no guessing from folder names alone. */
interface Manifest { dir: string; rel: string; pkg: any; }
async function scanManifests(root: string, depth = 3): Promise<Manifest[]> {
  const out: Manifest[] = [];
  const walk = async (dir: string, d: number): Promise<void> => {
    if (d < 0) return;
    let entries; try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.name === "node_modules" || e.name.startsWith(".")) continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) await walk(p, d - 1);
      else if (e.name === "package.json") {
        try { out.push({ dir, rel: path.relative(root, dir) || ".", pkg: JSON.parse(await fs.readFile(p, "utf8")) }); } catch { /* unparseable manifest: evidence ignored, not guessed */ }
      }
    }
  };
  await walk(root, depth);
  return out;
}
const CENSUS_EXT: Record<string, string> = { ".dart": "dart", ".ts": "ts", ".tsx": "ts", ".js": "ts", ".jsx": "ts", ".py": "py" };
const CENSUS_SKIP = new Set(["node_modules", ".git", "dist", "build", ".next", ".akosua", ".dart_tool", "__pycache__", ".venv", ".idea", ".vscode"]);
/** Count code files by language (names only — no reads, so this stays
 * cheap on big trees; capped descent for pathological workspaces). */
export async function languageCensus(root: string, maxDirs = 4000): Promise<Record<string, number>> {
  const counts: Record<string, number> = {};
  let dirs = 0;
  const walk = async (dir: string): Promise<void> => {
    if (++dirs > maxDirs) return;
    let entries; try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.name.startsWith(".") || CENSUS_SKIP.has(e.name)) continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) await walk(p);
      else { const lang = CENSUS_EXT[path.extname(e.name)]; if (lang) counts[lang] = (counts[lang] ?? 0) + 1; }
    }
  };
  await walk(root);
  return counts;
}

async function findPubspec(root: string, depth = 4): Promise<{ rel: string; text: string } | undefined> {
  let found: { rel: string; text: string } | undefined;
  const walk = async (dir: string, d: number): Promise<void> => {
    if (d < 0 || found) return;
    let entries; try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.name === "node_modules" || e.name.startsWith(".")) continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) await walk(p, d - 1);
      else if (e.name === "pubspec.yaml") { found = { rel: path.relative(root, dir) || ".", text: await read(p) }; return; }
    }
  };
  await walk(root, depth);
  return found;
}

export async function fingerprintProject(root: string): Promise<StackFingerprint> {
  const pkgRaw = await read(path.join(root, "package.json"));
  const pkg = pkgRaw ? JSON.parse(pkgRaw || "{}") : {};
  // Monorepo reality: the interesting manifests live in services/*, apps/*,
  // packages/*. Merge deps from ALL manifests (depth 3) for detection, while
  // root scripts stay authoritative for verify commands when present.
  const manifests = await scanManifests(root);
  const deps: Record<string, string> = {};
  for (const m of manifests) Object.assign(deps, m.pkg.dependencies, m.pkg.devDependencies);
  const allText = await collectText(root, ["package.json", "src/main.ts", "main.ts", "docker-compose.yml", "docker-compose.yaml", "schema.prisma", "pubspec.yaml"], 2);
  const fp: StackFingerprint = { root, shape: "unknown", testCommands: [], verifyCommands: [] };

  const isMonorepo = Boolean(pkg.workspaces || await has(path.join(root, "pnpm-workspace.yaml")) ||
    await has(path.join(root, "turbo.json")) || await has(path.join(root, "nx.json")) ||
    await has(path.join(root, "lerna.json")) || /"workspaces"/.test(pkgRaw));
  if (isMonorepo) fp.shape = "monorepo";

  // Backend (search root + first-level service dirs)
  const hay = allText;
  if (deps["@nestjs/core"] || /@nestjs\/core/.test(hay)) {
    const transports: string[] = [];
    for (const [name, re] of [["NATS", /nats|Nats|jetstream/i], ["Kafka", /kafka/i], ["RabbitMQ", /amqp|rabbitmq/i], ["Redis", /Transport\.Redis|redis/i], ["gRPC", /grpc/i], ["TCP", /Transport\.TCP/]] as const)
      if (re.test(hay)) transports.push(name);
    fp.backend = { framework: "nestjs",
      adapter: /platform-fastify/.test(hay) ? "fastify" : "express",
      transports,
      orm: await has(path.join(root, "prisma/schema.prisma")) || /model\s+\w+\s*\{/.test(hay) && /prisma/.test(hay) ? "prisma"
         : /typeorm/.test(hay) ? "typeorm" : undefined };
  } else if (deps["express"]) fp.backend = { framework: "express", transports: [] };
  else if (deps["fastify"]) fp.backend = { framework: "fastify-standalone", transports: [] };

  if (deps["next"]) { fp.web = { framework: "nextjs" }; }
  else if (deps["react"] && deps["vite"]) fp.web = { framework: "react-vite" };

  const pub = await findPubspec(root);
  fp.languageCounts = await languageCensus(root).catch(() => ({}));
  if (pub) {
    fp.mobile = { framework: "flutter", state: /riverpod/.test(pub.text) ? "riverpod" : /flutter_bloc/.test(pub.text) ? "bloc" : "other" };
    fp.flutterDir = pub.rel;
  } else if (deps["react-native"] || deps["expo"]) fp.mobile = { framework: "react-native" };
  // Dart-dominance fallback (live failure 2026-10-20: a Flutter project
  // whose pubspec sat outside the search depth rendered as NOT Dart at
  // all). Evidence, labelled as such — never a silent guess.
  if (!fp.mobile && (fp.languageCounts.dart ?? 0) >= 5) {
    const total = Object.values(fp.languageCounts).reduce((a, b) => a + b, 0);
    if (total > 0 && (fp.languageCounts.dart ?? 0) / total >= 0.5) {
      fp.mobile = { framework: "flutter", state: "other" };
      fp.flutterDetectedFrom = `dart-source-dominance (${fp.languageCounts.dart}/${total} code files; no pubspec.yaml found within search depth)`;
    }
  }

  fp.python = await has(path.join(root, "pyproject.toml")) || await has(path.join(root, "requirements.txt"));
  if (fp.shape === "unknown" && (fp.backend || fp.web || fp.mobile)) fp.shape = "monolith";

  // Verify/test commands — detected, never assumed
  const scripts = pkg.scripts ?? {};
  if (scripts.test) fp.testCommands.push("npm test");
  if (scripts["test:e2e"]) fp.testCommands.push("npm run test:e2e");
  if (scripts.build) fp.verifyCommands.push("npm run build");
  if (scripts.lint) fp.verifyCommands.push("npm run lint");
  // Nested packages: only add per-package commands for scripts the ROOT does
  // not already cover (root workspace scripts are the monorepo convention).
  for (const m of manifests) {
    if (m.rel === ".") continue;
    const s = m.pkg.scripts ?? {};
    if (s.build && !scripts.build) fp.verifyCommands.push(`npm --prefix ${m.rel} run build`);
    if (s.lint && !scripts.lint) fp.verifyCommands.push(`npm --prefix ${m.rel} run lint`);
    if (s.test && !scripts.test) fp.testCommands.push(`npm --prefix ${m.rel} test`);
  }
  if (fp.mobile?.framework === "flutter") {
    const dir = fp.flutterDir;
    fp.verifyCommands.push(dir && dir !== "." ? `flutter analyze ${dir}` : "flutter analyze");
    fp.testCommands.push(dir && dir !== "." ? `flutter test ${dir}` : "flutter test");
  }
  if (fp.python) { fp.verifyCommands.push("python -m ruff check .", "python -m pytest -q"); }
  // Typecheck ONLY where TypeScript is actually present (dep or tsconfig).
  // Never add bare `npx tsc` blindly: in a non-TS project npx would try to
  // DOWNLOAD TypeScript and prompt interactively — a hang, not a check.
  const rootDeps = { ...pkg.dependencies, ...pkg.devDependencies };
  if (rootDeps["typescript"] || await has(path.join(root, "tsconfig.json"))) fp.verifyCommands.unshift("npx tsc --noEmit");
  return fp;
}

async function collectText(root: string, names: string[], depth: number): Promise<string> {
  let out = "";
  const walk = async (dir: string, d: number): Promise<void> => {
    if (d < 0) return;
    let entries; try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.name === "node_modules" || e.name.startsWith(".")) continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) await walk(p, d - 1);
      else if (names.includes(e.name)) out += "\n" + await read(p);
    }
  };
  await walk(root, depth);
  return out;
}

/** One-line primary-language truth from the census, e.g. "Dart — 96 of 112 code files (86%)". */
/** Compact orientation injected into the agent's system prompt at
 * assembly (Aider repo-map pattern: structure with EVERY request, ~15
 * lines — the agent starts oriented instead of spending its first turns
 * discovering the project). Detail stays JIT via project_brain/search. */
export function brainBrief(fp: StackFingerprint, keyFiles: string[] = []): string {
  const lines = [
    `# Project orientation (detected from evidence — trust, then verify)`,
    `- Shape: ${fp.shape}${primaryLanguageLine(fp).replace(/^\n/, " · ")}`,
    `- Stack: ${[
      fp.backend ? `backend ${fp.backend.framework}${fp.backend.adapter ? `/${fp.backend.adapter}` : ""}${fp.backend.orm ? ` + ${fp.backend.orm}` : ""}` : "",
      fp.web ? `web ${fp.web.framework}` : "",
      fp.mobile ? `mobile ${fp.mobile.framework}${fp.mobile.state ? ` (${fp.mobile.state})` : ""}` : "",
      fp.python ? "python" : "",
    ].filter(Boolean).join(" · ") || "no framework detected"}`,
    fp.flutterDir && fp.flutterDir !== "." ? `- Flutter app dir: ${fp.flutterDir}` : "",
    `- Verify commands: ${fp.verifyCommands.join(" · ") || "none detected"}`,
    `- Test commands: ${fp.testCommands.join(" · ") || "none detected"}`,
    ...(keyFiles.length ? [`- Key files (most depended-on): ${keyFiles.slice(0, 8).join(" · ")}`] : []),
    `Full file/symbol/contract map: project_brain tool (Understand) or semantic_search — fetch detail just-in-time, do not re-derive the stack.`,
  ];
  return lines.filter(Boolean).join("\n");
}

export function primaryLanguageLine(fp: StackFingerprint): string {
  const counts = fp.languageCounts ?? {};
  const entries = Object.entries(counts).sort((a, b) => b[1] - a[1]);
  if (!entries.length) return "";
  const total = entries.reduce((a, [, n]) => a + n, 0);
  const [lang, n] = entries[0];
  const name = lang === "dart" ? "Dart" : lang === "ts" ? "TypeScript/JS" : lang === "py" ? "Python" : lang;
  return `\n- Primary language: ${name} — ${n} of ${total} code files (${Math.round((n / total) * 100)}%)`;
}

export function renderProjectBrain(fp: StackFingerprint, fileSummaries: string): string {
  const b = fp.backend ? `${fp.backend.framework}${fp.backend.adapter ? ` (${fp.backend.adapter} adapter)` : ""}` +
    `${fp.backend.transports.length ? `, transports: ${fp.backend.transports.join("/")}` : ""}${fp.backend.orm ? `, ORM: ${fp.backend.orm}` : ""}` : "—";
  return `# Project Brain\n\n- Root: ${fp.root}\n- Shape: ${fp.shape}${primaryLanguageLine(fp)}\n- Backend: ${b}\n- Web: ${fp.web?.framework ?? "—"}\n- Mobile: ${fp.mobile ? `${fp.mobile.framework}${fp.mobile.state ? ` (${fp.mobile.state})` : ""}` : "—"}${fp.flutterDetectedFrom ? `\n- Flutter detection: ${fp.flutterDetectedFrom}` : ""}\n- Python: ${fp.python ? "yes" : "no"}\n- Verify commands: ${fp.verifyCommands.join(" · ") || "—"}\n- Test commands: ${fp.testCommands.join(" · ") || "—"}\n\n## Files\n${fileSummaries}\n`;
}
