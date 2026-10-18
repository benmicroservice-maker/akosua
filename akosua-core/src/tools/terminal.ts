import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import type { Tool } from "../agent/tools.js";

export type ShellKind = "powershell" | "gitbash" | "wsl" | "bash" | "sh";
/** Detect the user's shell. Windows-first (Akosua is Windows-first):
 * PowerShell is the default, Git Bash and WSL when detected/preferred. */
export function detectShell(platform: NodeJS.Platform, env: Record<string, string | undefined>, preferred?: ShellKind): ShellKind {
  if (preferred) return preferred;
  if (platform === "win32") {
    if (env.WSL_DISTRO_NAME || env.WSLENV) return "wsl";
    if (env.MSYSTEM) return "gitbash";
    return "powershell";
  }
  return platform === "linux" || env.SHELL?.includes("bash") ? "bash" : "sh";
}
export function shellCommand(kind: ShellKind): { cmd: string; args: string[] } {
  switch (kind) {
    case "powershell": return { cmd: "powershell.exe", args: ["-NoLogo", "-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", "-"] };
    case "gitbash": return { cmd: "bash.exe", args: ["--login", "-s"] };
    case "wsl": return { cmd: "wsl.exe", args: ["--", "bash", "-s"] };
    case "bash": return { cmd: "/bin/bash", args: ["-s"] };
    default: return { cmd: "/bin/sh", args: ["-s"] };
  }
}

interface Pending { marker: string; resolve: (out: string, code: number) => void; reject: (e: Error) => void; timer: NodeJS.Timeout; }

/** Persistent terminal session: cwd + env survive between commands
 * (nanoclaude/libtmux lesson, cross-platform). A unique marker line
 * delimits each command's output AND captures its exit code. Commands are
 * executed strictly in submission order. */
export class PersistentTerminal {
  private proc?: ChildProcessWithoutNullStreams;
  private buf = "";
  private queue: Pending[] = [];
  private seq = 0;
  constructor(private kind: ShellKind = detectShell(process.platform, process.env), private cwd: string) {}

  private ensure() {
    if (this.proc) return;
    const { cmd, args } = shellCommand(this.kind);
    this.proc = spawn(cmd, args, { cwd: this.cwd });
    const on = (d: Buffer) => { this.buf += d.toString(); this.drain(); };
    this.proc.stdout.on("data", on);
    this.proc.stderr.on("data", on);
    this.proc.on("exit", () => { for (const p of this.queue.splice(0)) { clearTimeout(p.timer); p.reject(new Error("Terminal process exited")); } });
  }

  private drain() {
    for (;;) {
      const head = this.queue[0]; if (!head) return;
      const idx = this.buf.indexOf(head.marker + ":");
      if (idx < 0) return;
      const nl = this.buf.indexOf("\n", idx);
      if (nl < 0) return;
      const code = Number(this.buf.slice(idx + head.marker.length + 1, nl).trim()) || 0;
      const out = this.buf.slice(0, idx).replace(/\r/g, "").trimEnd();
      this.buf = this.buf.slice(nl + 1);
      this.queue.shift(); clearTimeout(head.timer); head.resolve(out, code);
    }
  }

  async run(command: string, timeoutMs = 120_000): Promise<{ output: string; exitCode: number }> {
    this.ensure();
    const marker = `__AKOSUA_END_${++this.seq}__`;
    const script = this.kind === "powershell"
      ? `${command}\nWrite-Output "${marker}:$LASTEXITCODE"\n`
      : `${command}\necho ${marker}:$?\n`;
    const done = new Promise<{ output: string; exitCode: number }>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Command timed out after ${timeoutMs}ms: ${command}`)), timeoutMs);
      this.queue.push({ marker, timer, resolve: (output, exitCode) => resolve({ output, exitCode }), reject });
    });
    this.proc!.stdin.write(script);
    return done;
  }

  async runText(command: string, timeoutMs?: number): Promise<string> {
    const { output, exitCode } = await this.run(command, timeoutMs);
    return `${output}\n[exit code: ${exitCode}]`;
  }

  async close() { try { this.proc?.stdin.end(); } catch { /* already closed */ } this.proc?.kill(); this.proc = undefined; }
}

export const terminalTool = (terminals: Map<string, PersistentTerminal> = new Map()): Tool => ({
  definition: { name: "terminal", description: "Run a command in the PERSISTENT terminal session (working directory and environment persist between calls). Use for installing deps, running the app, tests and checks. Output ends with the exit code. Do not block forever on servers - start them detached/with redirected output.",
    parameters: { type: "object", required: ["command"], properties: { command: { type: "string" }, session: { type: "string", description: "Session name, default 'main'" } } } },
  // Build/Verify ONLY (audit finding): a shell in Understand would let the
  // agent mutate files (sed/echo >) before Understand+Research sign-off,
  // silently bypassing the file_editor phase gate. Observation in Understand
  // happens through the read-only codebase tools.
  phases: ["build", "verify"],
  async run(a, ctx) {
    const name = String(a.session ?? "main");
    if (!terminals.has(name)) terminals.set(name, new PersistentTerminal(undefined, ctx.workspaceRoot));
    return terminals.get(name)!.runText(String(a.command));
  },
});
