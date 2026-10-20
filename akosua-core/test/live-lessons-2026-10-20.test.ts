import { test } from "node:test";
import assert from "node:assert/strict";
import { Agent } from "../src/agent/loop.js";
import { ToolRegistry } from "../src/agent/tools.js";
import type { ChatMessage, ModelProvider } from "../src/providers/types.js";
import { dropOrphanToolMessages } from "../src/providers/openai.js";
import { redactForFlightLog } from "../src/agent/flightRecorder.js";
import { Context7Client } from "../src/research/clients.js";
import { InMemorySecretStore, SecretKeys } from "../src/secrets.js";

/** Live lessons from the 2026-10-20 diagnostics bundles (user's machine):
 * run "so you cant use terminal" died on OpenAI 400 — the loop injected
 * diagnostics as a role:"tool" message with a fabricated id (diag-5) that
 * no assistant tool_call had issued. These tests pin the fix at BOTH
 * layers: the loop must never create such a message, and the provider
 * must refuse to ship one. */

function assertNoOrphanTools(messages: ChatMessage[], label: string) {
  const valid = new Set<string>();
  for (const m of messages) {
    if (m.role === "assistant") for (const tc of m.toolCalls ?? []) valid.add(tc.id);
    if (m.role === "tool") assert.ok(m.toolCallId && valid.has(m.toolCallId),
      `${label}: orphan tool message (id=${m.toolCallId}) would 400 at OpenAI`);
  }
}

test("loop: diagnostics+formatter notes never become orphan tool messages", async () => {
  const requests: ChatMessage[][] = [];
  let turn = 0;
  const provider: ModelProvider = { id: "openai", async *complete(req) {
    turn++;
    requests.push(req.messages.map(m => ({ ...m })));
    if (turn === 1) yield { type: "text", delta: "UNDERSTANDING COMPLETE: x RESEARCH COMPLETE: y PLAN COMPLETE: z" };
    else if (turn === 2) yield { type: "toolCall", call: { id: "call-real-1", name: "file_editor", arguments: JSON.stringify({ path: "src/a.ts" }) } };
    else if (turn === 3) yield { type: "text", delta: "BUILD COMPLETE: edited" };
    else yield { type: "text", delta: "VERIFICATION COMPLETE: done" };
    yield { type: "done", stopReason: "stop" };
  } };
  const registry = new ToolRegistry();
  registry.register({ definition: { name: "file_editor", description: "edit", parameters: { type: "object", properties: {} } },
    phases: ["build"], run: async () => "edited src/a.ts" });
  registry.register({ definition: { name: "run_verification", description: "verify", parameters: { type: "object", properties: {} } },
    phases: ["verify"], run: async () => "PASS" });
  const agent = new Agent({ provider, model: "m", systemPrompt: "s", lane: "act",
    afterEdit: async () => "formatted 1 file",
    diagnostics: async () => "TypeScript diagnostics: 1 error in src/a.ts" }, registry, "/tmp");
  for await (const _e of agent.run("task")) { /* drain */ }
  assert.ok(requests.length >= 3, "provider saw multiple turns");
  for (const [i, msgs] of requests.entries()) assertNoOrphanTools(msgs, `request ${i}`);
  const flat = requests.flat().map(m => m.content).join("\n");
  assert.match(flat, /\[diagnostics\]\nTypeScript diagnostics: 1 error/, "diagnostics still reach the model, appended to a real tool result");
  assert.match(flat, /\[formatter\]\nformatted 1 file/, "formatter note still reaches the model");
});

test("provider guard: dropOrphanToolMessages drops fabricated ids, keeps real answers", () => {
  const msgs: ChatMessage[] = [
    { role: "system", content: "s" },
    { role: "user", content: "u" },
    { role: "assistant", content: "", toolCalls: [{ id: "call-1", name: "file_editor", arguments: "{}" }] },
    { role: "tool", content: "real result", toolCallId: "call-1", name: "file_editor" },
    { role: "tool", content: "harness note with fake id", toolCallId: "diag-5", name: "diagnostics" },
    { role: "tool", content: "no id at all", name: "formatter" },
    { role: "assistant", content: "done" },
  ];
  const out = dropOrphanToolMessages(msgs);
  assert.equal(out.length, 5);
  assert.ok(!out.some(m => m.content.includes("fake id")), "fabricated diag id dropped");
  assert.ok(out.some(m => m.content === "real result"), "real tool answer kept");
});

test("flight recorder redaction: undefined values are ABSENT, never the string \"undefined\"", () => {
  const out = redactForFlightLog({ backend: undefined, web: undefined, mobile: "react-native", nested: { head: undefined, ok: 1 } }) as Record<string, unknown>;
  assert.ok(!("backend" in out), "undefined key dropped (was shipped as 'undefined' string in live bundles)");
  assert.ok(!("web" in out));
  assert.equal(out.mobile, "react-native");
  assert.deepEqual(out.nested, { ok: 1 });
});

test("phase refusal names the phases where the tool actually runs", async () => {
  const registry = new ToolRegistry();
  registry.register({ definition: { name: "terminal", description: "run", parameters: { type: "object", properties: {} } },
    phases: ["build", "verify"], run: async () => "ok" });
  const out = await registry.run("terminal", {}, { workspaceRoot: "/tmp" }, "understand");
  assert.match(out, /it runs in: build, verify/);
  assert.match(out, /do NOT tell the user the capability does not exist/);
});

test("Context7: unknown pinned version falls back to unpinned docs, labelled", async () => {
  const secrets = new InMemorySecretStore(); await secrets.set(SecretKeys.context7, "ctx-test");
  const calls: string[] = [];
  const fetchFn = async (url: string) => {
    calls.push(url);
    if (url.includes("/search")) return { ok: true, json: async () => ({ results: [{ id: "/expo/expo" }] }), text: async () => "" };
    if (url.includes("57.0.0")) return { ok: false, status: 404, text: async () => JSON.stringify({ error: "version_not_found", message: "Version \"57.0.0\" not found" }), json: async () => ({}) };
    if (url.includes("/context")) return { ok: true, status: 200, text: async () => "LATEST EXPO DOCS", json: async () => ({}) };
    throw new Error("unexpected " + url);
  };
  const c = new Context7Client(secrets, undefined, fetchFn as never);
  const out = await c.docs("expo", "57.0.0", "start");
  assert.match(out, /LATEST EXPO DOCS/);
  assert.match(out, /UNPINNED \(latest\) docs/);
  assert.equal(calls.length, 3, "search + pinned attempt + unpinned retry");
});
