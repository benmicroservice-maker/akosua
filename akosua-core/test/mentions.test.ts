import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { parseMentions, resolveMentions } from "../src/agent/mentions.js";

test("parse: file mentions with optional ranges", () => {
  const ms = parseMentions("Fix @src/orders.service.ts and @apps/web/page.tsx:3-9 please; email me@example.com is not one");
  assert.deepEqual(ms.map(m => m.path), ["src/orders.service.ts", "apps/web/page.tsx"]);
  assert.equal(ms[1].from, 3); assert.equal(ms[1].to, 9);
});

test("resolve: pinned content verbatim, ranges honored, escapes/missing reported", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "akosua-mention-"));
  fs.mkdirSync(path.join(dir, "src"), { recursive: true });
  fs.writeFileSync(path.join(dir, "src/a.ts"), "l1\nl2\nl3\nl4\n");
  const out = await resolveMentions(dir, "look @src/a.ts:2-3 and @src/nope.ts and @../evil.ts");
  assert.match(out, /PINNED BY USER @src\/a.ts:2-3/);
  assert.match(out, /l2\nl3/);
  assert.match(out, /src\/nope.ts: NOT FOUND/);
  assert.match(out, /outside workspace/);
});

test("no mentions -> empty string (zero behavior change)", async () => {
  assert.equal(await resolveMentions("/tmp", "plain task, no pins"), "");
});
