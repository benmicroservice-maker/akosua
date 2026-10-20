import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { FlightRecorder, redactForFlightLog, summarizeFlightEvents, renderDiagnosticsReport, looksLikeFailure, type FlightEvent } from "../src/agent/flightRecorder.js";
import { Agent } from "../src/agent/loop.js";
import { ToolRegistry } from "../src/agent/tools.js";
import type { ModelProvider } from "../src/providers/types.js";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "akosua-flight-"));
const ev = (type: string, data: Record<string, unknown> = {}): FlightEvent =>
  ({ ts: "2026-10-19T00:00:00.000Z", seq: 1, session: "s", type, data });

test("redactForFlightLog: secret keys and secret-shaped values never survive", () => {
  const out = redactForFlightLog({
    apiKey: "sk-live-1234567890abcdef",
    nested: { Authorization: "Bearer abcdefghijklmnopqrstuvwxyz", note: "use [SECURITY_DATA] please" },
    list: ["token is github_pat_11B5IXK6Q0zvn1CSoNpEuz_abcdefgh", { password: "hunter2" }],
    safe: "ordinary text",
  }) as Record<string, any>;
  const flat = JSON.stringify(out);
  assert.ok(!flat.includes("sk-live"), "sk- value leaked");
  assert.ok(!flat.includes("abcdefghijklmnopqrstuvwxyz"), "bearer token leaked");
  assert.ok(!flat.includes("github_pat_11B5"), "github PAT leaked");
  assert.ok(!flat.includes("hunter2"), "password leaked");
  assert.equal(out.safe, "ordinary text");
  assert.equal(out.apiKey, "[REDACTED]");
});

test("redactForFlightLog: bounds strings, arrays, depth", () => {
  const long = "x".repeat(10_000);
  const out = redactForFlightLog({ result: long }, { maxString: 100 }) as Record<string, string>;
  assert.ok(out.result.length < 200 && out.result.includes("[truncated"));
  const deep = redactForFlightLog({ a: { b: { c: { d: { e: { f: { g: 1 } } } } } } });
  assert.ok(JSON.stringify(deep).includes("[max depth]"));
});

test("looksLikeFailure: conservative heuristics", () => {
  assert.equal(looksLikeFailure("Error: unknown tool"), true);
  assert.equal(looksLikeFailure("npm ERR! code 1"), true);
  assert.equal(looksLikeFailure("exit code 2"), true);
  assert.equal(looksLikeFailure("3 files changed, all good"), false);
  assert.equal(looksLikeFailure(42), false);
});

test("recorder writes JSONL, reads back, rotates by size, never throws on bad roots", () => {
  const root = tmp();
  const rec = new FlightRecorder(root, { maxFileBytes: 900 });
  const id = rec.startSession({ app: "test" });
  assert.ok(id);
  for (let i = 0; i < 30; i++) rec.record("tool", { name: "search_code", result: "y".repeat(120), durationMs: 5 });
  rec.record("run.end", { outcome: "done", durationMs: 1234 });
  const events = FlightRecorder.readEvents(rec.dir, 10);
  assert.ok(events.length >= 30, `expected >=30 events, got ${events.length}`);
  assert.ok(events.some(e => e.type === "session.start"), "session.start missing");
  assert.ok(events.some(e => e.type === "session.rotated"), "rotation should be recorded");
  assert.ok(fs.readdirSync(rec.dir).filter(f => f.endsWith(".jsonl")).length >= 2, "rotation should create part files");

  const broken = new FlightRecorder(path.join(root, "a-file-not-a-dir", "x"));
  fs.writeFileSync(path.join(root, "a-file-not-a-dir"), "nope");
  assert.doesNotThrow(() => { broken.startSession(); broken.record("tool", { name: "x" }); });
});

test("summarize + report: counts tools, failures, phases, compactions, annotations", () => {
  const events: FlightEvent[] = [
    ev("run.start", { task: "do it" }),
    ev("turn.start", {}), ev("turn.start", {}),
    ev("phase", { phase: "understand" }), ev("phase", { phase: "build" }),
    ev("tool", { name: "search_code", result: "found 3 files", durationMs: 40 }),
    ev("tool", { name: "terminal", result: "Error: command not found", durationMs: 10 }),
    ev("tool", { name: "search_code", result: "found 1 file", durationMs: 30 }),
    ev("context.compaction", { tokensBefore: 9000, tokensAfter: 4000 }),
    ev("review", { verdict: "approved" }),
    ev("changeset", { files: [{ path: "src/a.ts", status: "M" }, { path: "src/b.ts", status: "A" }] }),
    ev("user.annotation", { text: "it got stuck here" }),
    ev("error", { message: "Provider error in phase build" }),
    ev("run.end", { outcome: "done", durationMs: 61_000 }),
  ];
  const s = summarizeFlightEvents(events);
  assert.equal(s.runs, 1); assert.equal(s.turns, 2); assert.equal(s.toolCalls, 3);
  assert.equal(s.toolFailures, 1); assert.equal(s.compactions, 1);
  assert.equal(s.toolsByName.search_code.calls, 2);
  assert.equal(s.toolsByName.terminal.failures, 1);
  assert.deepEqual(s.filesChanged, ["src/a.ts", "src/b.ts"]);
  assert.equal(s.annotations[0].text, "it got stuck here");
  const md = renderDiagnosticsReport(events, { appVersion: "0.9.0-test" });
  assert.ok(md.includes("Akosua Diagnostics Report"));
  assert.ok(md.includes("search_code"));
  assert.ok(md.includes("it got stuck here"));
  assert.ok(md.includes("src/a.ts"));
});

test("buildBundle: one shareable JSON with report, summary, artifacts — redacted", () => {
  const root = tmp();
  const rec = new FlightRecorder(root);
  rec.startSession({ appVersion: "0.9.0-test" });
  rec.record("run.start", { task: "fix it with key sk-should-not-leak-123456" });
  rec.record("tool", { name: "file_editor", result: "edited", durationMs: 3, args: { path: "src/a.ts" } });
  rec.record("run.end", { outcome: "done", durationMs: 2000 });
  fs.mkdirSync(path.join(root, ".akosua", "runs"), { recursive: true });
  fs.writeFileSync(path.join(root, ".akosua", "runs", "plan-test.md"), "# plan\nuse [SECURITY_DATA]");
  const built = FlightRecorder.buildBundle(root, { appVersion: "0.9.0-test", workspaceName: "demo" });
  assert.ok(built); assert.equal(built!.eventCount, 4); // session.start + the 3 recorded events
  const bundle = JSON.parse(fs.readFileSync(built!.jsonPath, "utf8"));
  assert.equal(bundle.kind, "akosua-diagnostics");
  assert.ok(bundle.report.includes("demo") || bundle.meta.workspaceName === "demo");
  assert.equal(bundle.artifacts.length, 1);
  const flat = JSON.stringify(bundle);
  assert.ok(!flat.includes("sk-should-not-leak"), "bundle leaked secret from session log");
  assert.ok(fs.existsSync(built!.mdPath));
});

test("loop flight tap: a real Agent run records turn/model/tool/end + full args", async () => {
  const events: { type: string; data: Record<string, unknown> }[] = [];
  const tap = { record: (type: string, data: Record<string, unknown> = {}) => { events.push({ type, data }); } };
  const registry = new ToolRegistry();
  registry.register({
    definition: { name: "search_code", description: "search", parameters: { type: "object", properties: { q: { type: "string" } } } },
    phases: ["understand"],
    run: async (args) => `found matches for ${String(args.q)}`,
  });
  let turn = 0;
  const provider: ModelProvider = { id: "anthropic", async *complete() {
    turn++;
    if (turn === 1) yield { type: "toolCall", call: { id: "c1", name: "search_code", arguments: JSON.stringify({ q: "orders" }) } };
    else yield { type: "text", delta: "UNDERSTANDING COMPLETE: done looking." };
    yield { type: "done", stopReason: "stop" };
  } };
  const agent = new Agent({ provider, model: "fake", systemPrompt: "s", flight: tap }, registry, tmp());
  for await (const _e of agent.run("find the orders code")) { /* drain */ }
  const types = events.map(e => e.type);
  for (const want of ["run.start", "turn.start", "model.response", "tool", "run.end"]) {
    assert.ok(types.includes(want), `missing flight event ${want}; got ${types.join(",")}`);
  }
  const toolEv = events.find(e => e.type === "tool")!;
  assert.equal(toolEv.data.name, "search_code");
  assert.deepEqual(toolEv.data.args, { q: "orders" });
  assert.equal(toolEv.data.result, "found matches for orders");
  const modelEv = events.find(e => e.type === "model.response" && Array.isArray((e.data as any).toolCalls) && (e.data as any).toolCalls.length)!;
  assert.equal((modelEv.data as any).toolCalls[0].name, "search_code");
});

test("v2: model.response carries latency, stop reason, usage; summary aggregates tokens + detects loops", async () => {
  const events: { type: string; data: Record<string, unknown> }[] = [];
  const tap = { record: (type: string, data: Record<string, unknown> = {}) => { events.push({ type, data }); } };
  const registry = new ToolRegistry();
  registry.register({
    definition: { name: "search_code", description: "search", parameters: { type: "object", properties: { q: { type: "string" } } } },
    phases: ["understand"],
    run: async (args) => `found matches for ${String(args.q)}`,
  });
  let turn = 0;
  const provider: ModelProvider = { id: "openai", async *complete() {
    turn++;
    // Two tool turns (the third identical call is repeat-blocked by the
    // loop BEFORE running, but still recorded - that IS the loop signal),
    // then the sign-off turn, then one no-progress nudge + goodbye turn.
    if (turn <= 3) yield { type: "toolCall", call: { id: `c${turn}`, name: "search_code", arguments: JSON.stringify({ q: "same" }) } };
    else yield { type: "text", delta: "UNDERSTANDING COMPLETE: done." };
    yield { type: "done", stopReason: "tool_calls", usage: { inputTokens: 100, outputTokens: 25, cachedInputTokens: 40 }, responseModel: "fake-1" };
  } };
  const agent = new Agent({ provider, model: "fake", systemPrompt: "SYS-PROMPT-MARKER", flight: tap }, registry, tmp());
  for await (const _e of agent.run("loop check")) { /* drain */ }
  const mr = events.find(e => e.type === "model.response")!;
  assert.equal(mr.data.stopReason, "tool_calls");
  assert.equal(mr.data.responseModel, "fake-1");
  assert.deepEqual(mr.data.usage, { inputTokens: 100, outputTokens: 25, cachedInputTokens: 40 });
  assert.equal(typeof mr.data.durationMs, "number");
  assert.equal(typeof mr.data.ttftMs, "number");
  const start = events.find(e => e.type === "run.start")!;
  assert.ok(String(start.data.systemPrompt).includes("SYS-PROMPT-MARKER"));
  assert.ok((start.data.toolsByPhase as Record<string, string[]>).understand.includes("search_code"));
  const toolEv = events.find(e => e.type === "tool")!;
  assert.equal(toolEv.data.callId, "c1");
  assert.equal(toolEv.data.ok, true);
  // summarizeFlightEvents speaks FlightEvent shape; adapt
  const fe = events.map((e, i) => ({ ts: new Date().toISOString(), seq: i + 1, session: "t", type: e.type, data: e.data })) as never[];
  const sum = summarizeFlightEvents(fe);
  const modelCalls = events.filter(e => e.type === "model.response").length;
  assert.equal(sum.inputTokens, modelCalls * 100);
  assert.equal(sum.outputTokens, modelCalls * 25);
  assert.equal(sum.loops.length, 1);
  assert.equal(sum.loops[0].tool, "search_code");
  assert.equal(sum.loops[0].count, 3); // 2 executed + 1 repeat-blocked, all recorded
  const report = renderDiagnosticsReport(fe, { workspaceName: "demo" });
  assert.ok(report.includes("## Model usage"));
  assert.ok(report.includes("LOOP:"));
  assert.ok(report.includes("## Runs (in order)"));
  // recorder stats + raised preview: a 5k tool result survives whole
  const root = tmp();
  const rec = new FlightRecorder(root);
  rec.startSession({});
  rec.record("tool", { name: "file_editor", result: "x".repeat(5000) });
  assert.equal(rec.stats().written, 2);
  assert.equal(rec.stats().writeErrors, 0);
  const back = FlightRecorder.readEvents(rec.dir);
  assert.equal(String((back.find(e => e.type === "tool")!.data as any).result).length, 5000);
});

test("v3: runId threading, final history digest, cost estimate, stuck signals", async () => {
  const events: { type: string; data: Record<string, unknown> }[] = [];
  const tap = { record: (type: string, data: Record<string, unknown> = {}) => { events.push({ type, data }); } };
  const registry = new ToolRegistry();
  registry.register({ definition: { name: "search_code", description: "s", parameters: { type: "object", properties: {} } }, phases: ["understand"], run: async () => "ok" });
  const provider: ModelProvider = { id: "openai", async *complete() {
    yield { type: "text", delta: "UNDERSTANDING COMPLETE: done." };
    yield { type: "done", stopReason: "stop", usage: { inputTokens: 1_000_000, outputTokens: 100_000 }, responseModel: "gpt-6.1-sol" };
  } };
  const agent = new Agent({ provider, model: "gpt-6.1-sol", systemPrompt: "s", flight: tap }, registry, tmp());
  for await (const _e of agent.run("cost check")) { /* drain */ }
  const start = events.find(e => e.type === "run.start")!;
  const end = events.find(e => e.type === "run.end")!;
  assert.ok(start.data.runId); assert.equal(end.data.runId, start.data.runId);
  assert.ok(Array.isArray(end.data.historyDigest) && (end.data.historyDigest as unknown[]).length >= 3);
  const fe = events.map((e, i) => ({ ts: new Date().toISOString(), seq: i + 1, session: "t", type: e.type, data: e.data })) as never[];
  const sum = summarizeFlightEvents(fe);
  const callsN = events.filter(e => e.type === "model.response").length;
  assert.ok(Math.abs(sum.estimatedCostUSD - callsN * (2.0 + 0.8)) < 0.01, `cost ${sum.estimatedCostUSD}`); // per call: 1M in @ $2 + 100k out @ $8
  assert.equal(sum.stuckSignals.length, 0);
  // a run with no end is a stuck signal
  const orphan = summarizeFlightEvents([{ ts: "t", seq: 1, session: "s", type: "run.start", data: {} }] as never[]);
  assert.ok(orphan.stuckSignals.some(x => x.includes("no run.end")));
});
