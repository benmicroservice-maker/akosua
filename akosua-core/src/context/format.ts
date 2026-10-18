import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";

/**
 * Lifecycle hooks (harness subsystem #6): deterministic work the HARNESS does
 * after edits, without spending model tokens or trusting the model to remember.
 * v1: format-on-edit — but only with the formatter the project itself declares
 * (prettier dep/config, pubspec for Dart, ruff config/dep for Python). If none
 * is declared, we say nothing and run nothing: never guess a project's style.
 * Formatting failure never fails the edit; it is reported as evidence.
 */
export interface FormatCommand { cmd: string; args: string[]; cwd: string; label: string; }

const run = (cwd: string, cmd: string, args: string[], ms = 60_000) => new Promise<{ code: number; out: string; missing: boolean }>(resolve => {
  execFile(cmd, args, { cwd, timeout: ms, maxBuffer: 2 * 1024 * 1024 },
    (e, so, se) => {
      const missing = !!e && (e as { code?: unknown }).code === "ENOENT";
      resolve({ code: e ? (typeof (e as { code?: unknown }).code === "number" ? (e as { code: number }).code : 1) : 0, out: `${so}\n${se}`, missing });
    });
});

async function exists(p: string): Promise<boolean> { try { await fs.stat(p); return true; } catch { return false; } }

async function nearestDir(startDir: string, root: string, marker: string): Promise<string | undefined> {
  let dir = startDir;
  for (let i = 0; i < 8; i++) {
    if (await exists(path.join(dir, marker))) return dir;
    if (dir === root) break;
    const parent = path.dirname(dir); if (parent === dir) break; dir = parent;
  }
  return undefined;
}

/** Pure-ish planner: which formatter commands (if any) apply to these files. */
export async function planFormatting(root: string, files: string[]): Promise<FormatCommand[]> {
  const out: FormatCommand[] = [];
  const byExt = new Map<string, string[]>();
  for (const f of files) byExt.set(path.extname(f), [...(byExt.get(path.extname(f)) ?? []), f]);

  const webFiles = [".ts", ".tsx", ".js", ".jsx", ".json"].flatMap(e => byExt.get(e) ?? []);
  if (webFiles.length) {
    const pkgDir = await nearestDir(path.dirname(path.resolve(root, webFiles[0])), root, "package.json");
    if (pkgDir) {
      let declared = false;
      try {
        const pkg = JSON.parse(await fs.readFile(path.join(pkgDir, "package.json"), "utf8")) as { dependencies?: object; devDependencies?: object };
        declared = "prettier" in { ...pkg.dependencies, ...pkg.devDependencies };
      } catch { /* handled below */ }
      if (!declared) declared = await exists(path.join(pkgDir, ".prettierrc")) || await exists(path.join(pkgDir, "prettier.config.js")) || await exists(path.join(pkgDir, ".prettierrc.json"));
      if (declared) {
        const rel = webFiles.map(f => path.relative(pkgDir, path.resolve(root, f)));
        out.push({ cmd: "npx", args: ["prettier", "--write", ...rel], cwd: pkgDir, label: "Prettier" });
      }
    }
  }
  const dartFiles = byExt.get(".dart") ?? [];
  if (dartFiles.length) {
    const pubDir = await nearestDir(path.dirname(path.resolve(root, dartFiles[0])), root, "pubspec.yaml");
    if (pubDir) out.push({ cmd: "dart", args: ["format", ...dartFiles.map(f => path.relative(pubDir, path.resolve(root, f)))], cwd: pubDir, label: "dart format" });
  }
  const pyFiles = byExt.get(".py") ?? [];
  if (pyFiles.length) {
    // Ruff only when the project declares it (pyproject [tool.ruff], ruff.toml, or a ruff dep string).
    let declared = false;
    for (const marker of ["ruff.toml", ".ruff.toml"]) if (await exists(path.join(root, marker))) declared = true;
    if (!declared) {
      const pyproject = await fs.readFile(path.join(root, "pyproject.toml"), "utf8").catch(() => "");
      declared = /\[tool\.ruff/.test(pyproject) || /\bruff\b/.test(pyproject);
    }
    if (declared) out.push({ cmd: "ruff", args: ["format", ...pyFiles.map(f => path.relative(root, path.resolve(root, f)))], cwd: root, label: "ruff format" });
  }
  return out;
}

/** Execute planned formatters; returns human evidence ("" when nothing planned). */
export async function runFormatting(root: string, files: string[]): Promise<string> {
  const plans = await planFormatting(root, files);
  if (!plans.length) return "";
  const notes: string[] = [];
  for (const p of plans) {
    const r = await run(p.cwd, p.cmd, p.args);
    if (r.missing) notes.push(`${p.label}: COULD-NOT-RUN (formatter not installed) — files left exactly as edited.`);
    else if (r.code === 0) notes.push(`${p.label}: formatted edited file(s) (${path.relative(root, p.cwd) || "."}).`);
    else notes.push(`${p.label}: FAILED (exit ${r.code}) — files left as edited. Output: ${r.out.split("\n").filter(l => l.trim()).slice(0, 5).join(" | ")}`);
  }
  return notes.join("\n");
}
