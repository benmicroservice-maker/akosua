import { test } from "node:test";
import assert from "node:assert/strict";
import { renderBrainV2 } from "../src/context/indexer.js";
import type { StackFingerprint } from "../src/context/fingerprint.js";
import type { ProjectIndex } from "../src/context/indexer.js";

test("Brain render is budgeted: file map caps with a stated remainder", () => {
  const fp = { root: "/r", shape: "monorepo", verifyCommands: [], testCommands: [] } as unknown as StackFingerprint;
  const files = Array.from({ length: 600 }, (_, i) => ({
    path: `src/f${i}.ts`, language: "ts", symbols: ["s"], imports: [], routes: [], events: [], dtos: [], consumers: [],
  }));
  const idx = { files, contracts: { http: [], events: [], dtos: [], consumers: [] }, indexedAt: "now" } as unknown as ProjectIndex;
  const out = renderBrainV2(fp, idx);
  assert.match(out, /and 350 more files/);
  assert.ok(out.length < 60_000, `Brain render must stay a map, got ${out.length} chars`);
});
