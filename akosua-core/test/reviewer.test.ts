import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { Agent } from "../src/agent/loop.js";
import { ToolRegistry } from "../src/agent/tools.js";
import { createCheckpoint } from "../src/tools/git.js";
import type { ModelProvider } from "../src/providers/types.js";

function scripted(id: "anthropic" | "openai", texts: string[], counter?: { n: number }): ModelProvider {
  let i = 0;
  return { id, async *complete() {
    if (counter) counter.n++;
    yield { type: "text", delta: texts[Math.min(i++, texts.length - 1)] };
    yield { type: "done", stopReason: "stop" };
  } };
}
const sh = (cwd: string, args: string[]) => new Promise<string>((res, rej) =>
  execFile(args[0], args.slice(1), { cwd }, (e, so, se) => e ? rej(new Error(se)) : res(so)));

test("reviewer gate: CHANGES REQUESTED sends agent back to Build, APPROVED lets it Verify", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "akosua-review-"));
  await sh(root, ["git", "init", "-q"]); await sh(root, ["git", "config", "user.email", "t@t.t"]); await sh(root, ["git", "config", "user.name", "T"]);
  await fs.writeFile(path.join(root, "app.ts"), "export const v = 1;\n");
  await sh(root, ["git", "add", "."]); await sh(root, ["git", "commit", "-qm", "init"]);
  await createCheckpoint(root, "test");
  await fs.writeFile(path.join(root, "app.ts"), "export const v = 2; // TODO sloppy\n");

  const plannerCalls = { n: 0 }, reviewerCalls = { n: 0 };
  const planner = scripted("anthropic", [
    "Read the code. UNDERSTANDING COMPLETE: app.ts holds v",
    "No external APIs. RESEARCH COMPLETE: local",
    "Bump v to 2. PLAN COMPLETE: one line",
    "BUILD COMPLETE: v bumped to 2",
    "Fixed the TODO. BUILD COMPLETE: v bumped, TODO removed",
    "VERIFICATION COMPLETE: checks reported honestly",
  ], plannerCalls);
  const reviewer = scripted("openai", [
    "app.ts still contains a sloppy TODO comment the builder did not mention.\nREVIEW VERDICT: CHANGES REQUESTED",
    "Diff is now clean and matches the summary.\nREVIEW VERDICT: APPROVED",
  ], reviewerCalls);

  const agent = new Agent(
    { provider: planner, model: "claude-x", systemPrompt: "test", lane: "act", routing: { reviewer: { provider: reviewer, model: "gpt-x" } } },
    new ToolRegistry(), root);
  const reviews: string[] = [];
  let donePhase = "";
  for await (const e of agent.run("bump v to 2")) {
    if (e.type === "review") reviews.push(e.verdict);
    if (e.type === "done") donePhase = e.phase;
  }
  assert.deepEqual(reviews, ["changes_requested", "approved"], "reviewer must gate twice: reject then approve");
  assert.equal(reviewerCalls.n, 2);
  assert.equal(donePhase, "verify");
  assert.ok(agent.history.some(m => m.content.includes("CHANGES REQUESTED. You are still in Build")), "findings must be fed back into Build");
});

test("reviewer gate: unavailable reviewer never blocks the run, and is disclosed", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "akosua-review2-"));
  const planner = scripted("anthropic", [
    "UNDERSTANDING COMPLETE: x", "RESEARCH COMPLETE: x", "PLAN COMPLETE: x",
    "BUILD COMPLETE: x", "VERIFICATION COMPLETE: done, review unavailable noted",
  ]);
  const broken: ModelProvider = { id: "openai", async *complete() { throw new Error("reviewer service down"); } };
  const agent = new Agent(
    { provider: planner, model: "claude-x", systemPrompt: "test", lane: "act", routing: { reviewer: { provider: broken, model: "gpt-x" } } },
    new ToolRegistry(), root);
  const reviews: string[] = []; let donePhase = "";
  for await (const e of agent.run("task")) {
    if (e.type === "review") reviews.push(e.verdict);
    if (e.type === "done") donePhase = e.phase;
  }
  assert.deepEqual(reviews, ["unavailable"]);
  assert.equal(donePhase, "verify", "run completes despite reviewer outage");
  assert.ok(agent.history.some(m => m.content.includes("do not claim the work was reviewed")), "non-review must be disclosed to the agent");
});

test("model routing: Editor model drives Build turns, Planner drives the rest", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "akosua-routing-"));
  const plannerCalls = { n: 0 }, editorCalls = { n: 0 };
  const planner = scripted("anthropic", [
    "UNDERSTANDING COMPLETE: x", "RESEARCH COMPLETE: x", "PLAN COMPLETE: x", "VERIFICATION COMPLETE: x",
  ], plannerCalls);
  const editor = scripted("openai", ["BUILD COMPLETE: edited"], editorCalls);
  const agent = new Agent(
    { provider: planner, model: "claude-plan", systemPrompt: "test", lane: "act",
      routing: { editor: { provider: editor, model: "gpt-edit" } } },
    new ToolRegistry(), root);
  let donePhase = "";
  for await (const e of agent.run("task")) if (e.type === "done") donePhase = e.phase;
  assert.equal(donePhase, "verify");
  assert.equal(editorCalls.n, 1, "exactly the Build turn must go to the Editor model");
  // Planner: Understand/Research/Plan + Verify sign-off BLOCKED twice by the
  // verify gate (bare registry has no run_verification tool) + final turn = 6.
  assert.equal(plannerCalls.n, 6, "Understand/Research/Plan stay with the Planner; Verify sign-off is gate-blocked there");
});
