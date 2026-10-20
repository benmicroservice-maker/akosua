import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";

/** Diagnostics-after-edit (HARNESS_RESEARCH A3): Cursor's Fast Apply loop wins
 * because lint/compiler truth flows back to the agent after every edit. This
 * is Akosua's version: after file_editor calls in Build, run the CHEAPEST
 * oracle for the touched package and hand the agent parsed diagnostics.
 * Deliberately conservative — a check that cannot run says so, never guesses. */

const run = (cwd: string, cmd: string, args: string[], ms = 120_000) => new Promise<{ code: number; out: string }>(resolve => {
  execFile(cmd, args, { cwd, timeout: ms, maxBuffer: 4 * 1024 * 1024 },
    (e, so, se) => resolve({ code: e ? (typeof (e as { code?: unknown }).code === "number" ? (e as { code: number }).code : 1) : 0, out: `${so}\n${se}` }));
});

async function nearestFile(startDir: string, root: string, name: string): Promise<string | undefined> {
  let dir = startDir;
  for (let i = 0; i < 8; i++) {
    try { await fs.stat(path.join(dir, name)); return dir; } catch { /* climb */ }
    if (dir === root) break;
    const parent = path.dirname(dir); if (parent === dir) break; dir = parent;
  }
  return undefined;
}

/** Parse tsc/flutter output into the lines a model can act on. */
export function parseDiagnostics(raw: string, maxLines = 40): string {
  const lines = raw.split("\n").filter(l => /(error|warning)/i.test(l) && /\(\d+,\d+\)|:\d+:\d+|error TS|•/.test(l));
  const picked = (lines.length ? lines : raw.split("\n").filter(l => l.trim())).slice(0, maxLines);
  return picked.join("\n");
}

export async function quickDiagnostics(root: string, files: string[]): Promise<string> {
  if (!files.length) return "";
  const notes: string[] = [];
  const byExt = new Map<string, string[]>();
  for (const f of files) byExt.set(path.extname(f), [...(byExt.get(path.extname(f)) ?? []), f]);

  const tsFiles = [...(byExt.get(".ts") ?? []), ...(byExt.get(".tsx") ?? [])];
  if (tsFiles.length) {
    const pkgDir = await nearestFile(path.dirname(path.resolve(root, tsFiles[0])), root, "package.json");
    const tsDir = await nearestFile(path.dirname(path.resolve(root, tsFiles[0])), root, "tsconfig.json");
    if (pkgDir && tsDir === pkgDir) {
      let hasTs = false;
      try {
        const pkg = JSON.parse(await fs.readFile(path.join(pkgDir, "package.json"), "utf8")) as { dependencies?: object; devDependencies?: object };
        hasTs = "typescript" in { ...pkg.dependencies, ...pkg.devDependencies };
      } catch { /* unreadable package.json: skip honestly below */ }
      if (hasTs) {
        const r = await run(pkgDir, "npx", ["tsc", "--noEmit", "-p", "tsconfig.json"]);
        notes.push(r.code === 0
          ? `TypeScript diagnostics (${path.relative(root, pkgDir) || "."}): CLEAN (tsc --noEmit passed after your edits).`
          : `TypeScript diagnostics (${path.relative(root, pkgDir) || "."}) — fix these before signing off Build:\n${parseDiagnostics(r.out)}`);
      } else notes.push("TypeScript diagnostics: SKIPPED (typescript not a declared dependency of the touched package — not guessing).");
    }
  }
  const dartFiles = byExt.get(".dart") ?? [];
  if (dartFiles.length) {
    const pubDir = await nearestFile(path.dirname(path.resolve(root, dartFiles[0])), root, "pubspec.yaml");
    if (pubDir) {
      const rel = dartFiles.map(f => path.relative(pubDir, path.resolve(root, f)));
      const r = await run(pubDir, "flutter", ["analyze", ...rel]);
      notes.push(r.code === 0
        ? `Flutter diagnostics (${path.relative(root, pubDir)}): CLEAN (flutter analyze passed on edited files).`
        : `Flutter diagnostics (${path.relative(root, pubDir)}) — fix these before signing off Build:\n${parseDiagnostics(r.out)}`);
    }
  }
  return notes.join("\n");
}
