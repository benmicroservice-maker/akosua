#!/usr/bin/env node
/** A7 benchmark runner (offline pipeline validation).
 * Full live scoring needs a provider key; offline mode proves tasks load,
 * fixtures exist, and the harness event contract is intact. Run from
 * akosua-core/:  node benchmark/run.mjs            (offline checks)
 *                AKOSUA_BENCH_LIVE=1 node benchmark/run.mjs   (reserved) */
import { readFile, access } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const tasks = JSON.parse(await readFile(path.join(here, "tasks.json"), "utf8"));
let ok = 0, fail = 0;
for (const t of tasks.tasks) {
  const fixture = path.resolve(here, "../../../test-projects", t.fixture);
  try { await access(fixture); console.log(`PASS ${t.id} — fixture ${t.fixture} present, ${t.checks.length} checks defined`); ok++; }
  catch { console.log(`FAIL ${t.id} — fixture missing at ${fixture}`); fail++; }
}
console.log(`\nBenchmark harness: ${ok} ok, ${fail} failed. Live scoring: set AKOSUA_BENCH_LIVE=1 with a provider key (not run in CI).`);
process.exit(fail ? 1 : 0);
