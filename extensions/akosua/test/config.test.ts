import test from "node:test";
import assert from "node:assert/strict";
import { PROVIDERS, specFor, DEFAULT_ROUTING, maskedStatus } from "../src/config.js";

test("all five providers wired with unique secret keys + test endpoints", () => {
  assert.equal(PROVIDERS.length, 5);
  assert.equal(new Set(PROVIDERS.map(p => p.secretKey)).size, 5);
  for (const p of PROVIDERS) {
    assert.match(p.testUrl, /^https:\/\//);
    assert.ok(p.testHeaders("k") && Object.keys(p.testHeaders("k")).length > 0);
    assert.doesNotMatch(p.secretKey, /settings/i); // secrets != settings
  }
});
test("routing default: Claude plans+edits, OpenAI cross-reviews", () => {
  assert.deepEqual(DEFAULT_ROUTING, { planner: "anthropic", editor: "anthropic", reviewer: "openai" });
  assert.equal(specFor("context7").label, "Context7");
  assert.equal(maskedStatus(true), "● key saved");
  assert.equal(maskedStatus(false), "○ no key");
});

import { parseMcpServers } from "../src/config.js";
test("parseMcpServers: valid servers pass, malformed entries are reported not dropped silently", () => {
  const ok = parseMcpServers([{ name: "github", command: "npx", args: ["-y", "srv"] }, { name: 3 }, "junk"]);
  assert.equal(ok.servers.length, 1);
  assert.equal(ok.servers[0].allowBuild, false, "external tools stay out of Build by default");
  assert.equal(ok.errors.length, 2);
  assert.deepEqual(parseMcpServers(undefined), { servers: [], errors: [] });
  assert.match(parseMcpServers({}).errors[0], /must be an array/);
});
