import { spawn, execFile, type ChildProcess } from "node:child_process";
import { classifyCommand } from "../agent/permissions.js";
import { detectShell, type ShellKind } from "./terminal.js";
import type { Tool } from "../agent/tools.js";

/** Background terminal jobs (terminal-control research: Claude Code
 * run_in_background, VS Code send/get_terminal_output, OpenDev shell).
 * Foreground `terminal` blocks the loop; servers, watchers, builds and
 * test suites must NOT. A job starts detached, its output accumulates in
 * a capped ring buffer, and the agent polls/logs/waits/kills/sends input
 * by ID. Status always comes from the real child exit — never from
 * bookkeeping the harness merely believes. */

export interface BackgroundJob {
  id: string; command: string; cwd: string;
  status: "running" | "exited" | "killed" | "failed";
  startedAt: number; endedAt?: number; exitCode?: number;
}

interface Live extends BackgroundJob { proc: ChildProcess; buf: string; }

const MAX_BUF = 200_000; // tail cap per job (research: bounded, pageable)
const SERVER_RE = /\b(npm|pnpm|yarn|bun)\s+run\s+(dev|serve|start|preview|watch)\b|\b(next|vite|ng|nuxt)\s+(dev|serve|start)\b|\b(nodemon|tsx\s+watch|flutter\s+run|uvicorn|flask\s+run|rails\s+s|php\s+artisan\s+serve)\b/i;
export const looksLikeServer = (cmd: string): boolean => SERVER_RE.test(cmd);

function spawnSpec(kind: ShellKind, command: string): { cmd: string; args: string[] } {
  switch (kind) {
    case "powershell": return { cmd: "powershell.exe", args: ["-NoLogo", "-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", command] };
    case "gitbash": return { cmd: "bash.exe", args: ["--login", "-c", command] };
    case "wsl": return { cmd: "wsl.exe", args: ["--", "bash", "-c", command] };
    case "bash": return { cmd: "/bin/bash", args: ["-c", command] };
    default: return { cmd: "/bin/sh", args: ["-c", command] };
  }
}

export class BackgroundJobManager {
  private jobs = new Map<string, Live>();
  private seq = 0;
  constructor(private kind: ShellKind = detectShell(process.platform, process.env)) {}

  start(command: string, cwd: string): BackgroundJob {
    const id = `job-${++this.seq}`;
    const { cmd, args } = spawnSpec(this.kind, command);
    const proc = spawn(cmd, args, { cwd, windowsHide: true, detached: process.platform !== "win32" });
    const job: Live = { id, command, cwd, status: "running", startedAt: Date.now(), proc, buf: "" };
    this.jobs.set(id, job);
    const on = (d: Buffer) => { job.buf = (job.buf + d.toString()).slice(-MAX_BUF); };
    proc.stdout?.on("data", on); proc.stderr?.on("data", on);
    proc.on("error", (e) => { job.status = "failed"; job.endedAt = Date.now(); job.buf += `\n[akosua: spawn failed: ${e.message}]`; });
    proc.on("exit", (code) => { if (job.status === "running") job.status = "exited"; job.exitCode = code ?? undefined; job.endedAt = Date.now(); });
    return job;
  }

  get(id: string): Live | undefined { return this.jobs.get(id); }
  list(): BackgroundJob[] { return [...this.jobs.values()].map(({ id, command, cwd, status, startedAt, endedAt, exitCode }) => ({ id, command, cwd, status, startedAt, endedAt, exitCode })); }

  log(id: string, tailLines = 100): string {
    const j = this.jobs.get(id); if (!j) return `Error: no such job "${id}". Use action "list".`;
    const lines = j.buf.replace(/\r/g, "").split("\n");
    return lines.slice(-Math.max(1, tailLines)).join("\n");
  }

  async wait(id: string, timeoutMs = 30_000): Promise<BackgroundJob | undefined> {
    const j = this.jobs.get(id); if (!j) return undefined;
    const deadline = Date.now() + timeoutMs;
    while (j.status === "running" && Date.now() < deadline) await new Promise(r => { const t = setTimeout(r, 100); });
    return j;
  }

  async kill(id: string): Promise<string> {
    const j = this.jobs.get(id); if (!j) return `Error: no such job "${id}".`;
    if (j.status !== "running") return `${id} is already ${j.status}.`;
    j.status = "killed"; j.endedAt = Date.now();
    try {
      if (process.platform === "win32" && j.proc.pid) {
        await new Promise<void>((res) => execFile("taskkill", ["/pid", String(j.proc.pid), "/T", "/F"], () => res()));
      } else if (j.proc.pid) { try { process.kill(-j.proc.pid, "SIGTERM"); } catch { j.proc.kill("SIGTERM"); } }
    } catch { try { j.proc.kill(); } catch { /* already gone */ } }
    return `Killed ${id} (${j.command}).`;
  }

  send(id: string, text: string): string {
    const j = this.jobs.get(id); if (!j) return `Error: no such job "${id}".`;
    if (j.status !== "running") return `Error: ${id} is ${j.status}; cannot send input.`;
    j.proc.stdin?.write(text.endsWith("\n") ? text : text + "\n");
    return `Sent input to ${id}. Poll/log to see the response.`;
  }

  async closeAll(): Promise<void> { for (const j of this.jobs.values()) if (j.status === "running") await this.kill(j.id); this.jobs.clear(); }
}

const fmt = (j: BackgroundJob): string => {
  const dur = `${(((j.endedAt ?? Date.now()) - j.startedAt) / 1000).toFixed(1)}s`;
  return `${j.id} [${j.status}${j.exitCode !== undefined ? ` exit=${j.exitCode}` : ""}, ${dur}] ${j.command}`;
};

export const terminalJobsTool = (manager: BackgroundJobManager): Tool => ({
  definition: { name: "terminal_jobs", description: "Control BACKGROUND terminal jobs: dev servers, watchers, long builds/tests, anything that must keep running or outlives a foreground timeout. Actions: start (returns a job id immediately), poll (status), log (recent output), wait (block until exit or timeout), kill (stops the whole process tree), list, send (type input into the job, e.g. answering a prompt). NEVER run a server/watcher in the foreground terminal — start it here, wait a few seconds, then log to confirm it is up.",
    parameters: { type: "object", required: ["action"], properties: {
      action: { type: "string", enum: ["start", "poll", "log", "wait", "kill", "list", "send"] },
      command: { type: "string", description: "For start: the command line." },
      jobId: { type: "string", description: "For poll/log/wait/kill/send." },
      text: { type: "string", description: "For send: input line to type into the job." },
      timeoutMs: { type: "number", description: "For wait: max milliseconds to block (default 30000)." },
      tailLines: { type: "number", description: "For log: lines of recent output (default 100)." },
    } } },
  phases: ["build", "verify"],
  async run(a, ctx) {
    const action = String(a.action ?? "");
    if (action === "list") { const all = manager.list(); return all.length ? all.map(fmt).join("\n") : "No background jobs yet. Start one with action \"start\"."; }
    if (action === "start") {
      const command = String(a.command ?? "").trim();
      if (!command) return "Error: terminal_jobs start needs a \"command\".";
      const cls = classifyCommand(command);
      if (cls.tier === "destructive") {
        if (!ctx.confirm) return `Blocked (permission tier): destructive command (${cls.why}) with no confirmation UI attached. It was NOT started.`;
        if (!(await ctx.confirm(`Akosua agent wants to start a destructive background command (${cls.why}):\n\n${command}\n\nAllow it?`))) return "Blocked by the user: the destructive background command was NOT started.";
      }
      const job = manager.start(command, ctx.workspaceRoot);
      return `Started ${fmt(job)}${looksLikeServer(command) ? "\n(server-like command: wait ~5s, then action \"log\" to confirm it is listening before building on it)" : ""}`;
    }
    const id = String(a.jobId ?? "");
    if (!id) return `Error: terminal_jobs ${action} needs a "jobId" (see action "list").`;
    switch (action) {
      case "poll": { const j = manager.get(id); return j ? fmt(j) : `Error: no such job "${id}".`; }
      case "log": { const j = manager.get(id); if (!j) return `Error: no such job "${id}".`; return `${fmt(j)}\n--- recent output ---\n${manager.log(id, Number(a.tailLines ?? 100)) || "(no output yet)"}`; }
      case "wait": { const j = await manager.wait(id, Number(a.timeoutMs ?? 30_000)); if (!j) return `Error: no such job "${id}".`; return j.status === "running" ? `${fmt(j)} — still running after the wait. Log it, or wait again; do not restart it blindly.` : `${fmt(j)}\n--- recent output ---\n${manager.log(id, 60) || "(no output)"}`; }
      case "kill": return manager.kill(id);
      case "send": return manager.send(id, String(a.text ?? ""));
      default: return `Error: unknown action "${action}". Use start|poll|log|wait|kill|list|send.`;
    }
  },
});
