import { test } from "node:test";
import assert from "node:assert/strict";
import { BackgroundJobManager, looksLikeServer, terminalJobsTool } from "../src/tools/terminalJobs.js";

const isWin = process.platform === "win32";
const echoCmd = isWin ? "Write-Output hello-jobs" : "echo hello-jobs";
const sleepCmd = isWin ? "Start-Sleep -Seconds 30" : "sleep 30";

test("background job: start -> wait -> log captures output and exit", async () => {
  const m = new BackgroundJobManager();
  const job = m.start(echoCmd, process.cwd());
  const done = await m.wait(job.id, 15_000);
  assert.equal(done?.status, "exited");
  assert.match(m.log(job.id), /hello-jobs/);
  await m.closeAll();
});

test("background job: kill stops a long runner; list reflects it", async () => {
  const m = new BackgroundJobManager();
  const job = m.start(sleepCmd, process.cwd());
  assert.equal(m.list().length, 1);
  const msg = await m.kill(job.id);
  assert.match(msg, /Killed/);
  assert.equal(m.get(job.id)?.status, "killed");
  await m.closeAll();
});

test("terminal_jobs tool: start/poll/list/log via the tool surface", async () => {
  const m = new BackgroundJobManager();
  const tool = terminalJobsTool(m);
  const ctx = { workspaceRoot: process.cwd() } as never;
  const started = await tool.run({ action: "start", command: echoCmd }, ctx, "build");
  assert.match(started, /job-1/);
  const waited = await tool.run({ action: "wait", jobId: "job-1", timeoutMs: 15000 }, ctx, "build");
  assert.match(waited, /exited/);
  assert.match(waited, /hello-jobs/);
  const listed = await tool.run({ action: "list" }, ctx, "build");
  assert.match(listed, /job-1/);
  await m.closeAll();
});

test("looksLikeServer detects dev servers, not finite commands", () => {
  assert.equal(looksLikeServer("npm run dev"), true);
  assert.equal(looksLikeServer("npx vite serve"), true); // serve/dev verbs are long-running by definition
  assert.equal(looksLikeServer("vite dev"), true);
  assert.equal(looksLikeServer("npm test"), false);
  assert.equal(looksLikeServer("node server.js"), false);
});
