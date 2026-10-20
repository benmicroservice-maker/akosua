import { test } from "node:test";
import assert from "node:assert/strict";
import { profileFor } from "../src/agent/profiles.js";
import type { ModelProvider } from "../src/providers/types.js";

const prov = (id: "anthropic" | "openai"): ModelProvider => ({ id, async *complete() { yield { type: "done" as const, stopReason: "end" }; } });

test("profiles: family selected from provider/model, budgets generous", () => {
  assert.equal(profileFor(prov("anthropic"), "claude-opus-5-5").id, "anthropic");
  assert.equal(profileFor(prov("openai"), "gpt-6.1-sol").id, "openai");
  assert.equal(profileFor(prov("openai"), "claude-sonnet-5-5").id, "anthropic"); // model name wins for routed roles
  for (const p of [profileFor(prov("anthropic"), "x"), profileFor(prov("openai"), "y")])
    assert.ok(p.maxTokens >= 16_384 && p.promptSuffix.length > 50);
});
