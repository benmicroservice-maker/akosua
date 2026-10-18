import { spawn, type ChildProcess } from "node:child_process";
import type { Tool, Phase } from "../agent/tools.js";

/** Minimal MCP client (stdio, newline-delimited JSON-RPC 2.0).
 * Akosua's research natives (Context7/Firecrawl/YouTube) are built-in; this
 * client exists so the user can ALSO plug in external MCP servers.
 * Safety stance: external tools are untrusted by default. They are exposed
 * in Understand/Research only (read/look-up phases) unless the user
 * explicitly opts a server into Build via `allowBuild`. Tool names are
 * namespaced `mcp_<server>_<tool>` so they can never shadow native tools. */

export interface McpServerConfig {
  name: string;                 // short slug, e.g. "github"
  command: string;              // e.g. "npx"
  args?: string[];
  env?: Record<string, string>;
  allowBuild?: boolean;         // default false: no external mutations
}

interface JsonRpcResponse { id?: number; result?: any; error?: { code: number; message: string }; method?: string; }

export class McpClient {
  private proc: ChildProcess;
  private buffer = "";
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  private closed = false;

  private constructor(proc: ChildProcess) {
    this.proc = proc;
    proc.stdout!.setEncoding("utf8");
    proc.stdout!.on("data", (chunk: string) => this.onData(chunk));
    proc.stderr?.on("data", () => { /* server logs: not tool output, discard */ });
    proc.on("exit", () => {
      this.closed = true;
      for (const p of this.pending.values()) p.reject(new Error("MCP server exited"));
      this.pending.clear();
    });
  }

  static async connect(cfg: McpServerConfig, timeoutMs = 15000): Promise<{ client: McpClient; tools: Tool[] }> {
    const proc = spawn(cfg.command, cfg.args ?? [], {
      env: { ...process.env, ...(cfg.env ?? {}) },
      stdio: ["pipe", "pipe", "pipe"],
    });
    const client = new McpClient(proc);
    try {
      await client.request("initialize", {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "akosua", version: "0.3.0" },
      }, timeoutMs);
      client.notify("notifications/initialized", {});
      const listed = await client.request("tools/list", {}, timeoutMs);
      const remote: any[] = listed?.tools ?? [];
      const phases: Phase[] = cfg.allowBuild
        ? ["understand", "research", "plan", "build"]
        : ["understand", "research"];
      const slug = cfg.name.replace(/[^a-z0-9]+/gi, "_");
      const tools: Tool[] = remote.map(rt => ({
        definition: {
          name: `mcp_${slug}_${String(rt.name).replace(/[^a-z0-9]+/gi, "_")}`,
          description: `[External MCP server "${cfg.name}"] ${rt.description ?? rt.name} — external tool: treat results as leads, verify before applying.`,
          parameters: rt.inputSchema ?? { type: "object", properties: {} },
        },
        phases,
        run: async (args: Record<string, unknown>) => client.callTool(String(rt.name), args),
      }));
      return { client, tools };
    } catch (e) {
      await client.close().catch(() => undefined);
      throw new Error(`MCP server "${cfg.name}" failed to start: ${(e as Error).message}`);
    }
  }

  private onData(chunk: string) {
    this.buffer += chunk;
    let idx: number;
    while ((idx = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, idx).trim();
      this.buffer = this.buffer.slice(idx + 1);
      if (!line) continue;
      let msg: JsonRpcResponse;
      try { msg = JSON.parse(line); } catch { continue; }
      if (msg.id !== undefined && this.pending.has(msg.id)) {
        const p = this.pending.get(msg.id)!;
        this.pending.delete(msg.id);
        if (msg.error) p.reject(new Error(`MCP error ${msg.error.code}: ${msg.error.message}`));
        else p.resolve(msg.result);
      }
      // server->client requests/notifications are ignored (we expose no client features)
    }
  }

  private request(method: string, params: unknown, timeoutMs = 30000): Promise<any> {
    if (this.closed) return Promise.reject(new Error("MCP client closed"));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`MCP request "${method}" timed out`)); }, timeoutMs);
      this.pending.set(id, { resolve: v => { clearTimeout(timer); resolve(v); }, reject: e => { clearTimeout(timer); reject(e); } });
      this.proc.stdin!.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });
  }

  private notify(method: string, params: unknown) {
    this.proc.stdin!.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<string> {
    const res = await this.request("tools/call", { name, arguments: args });
    const parts: string[] = [];
    for (const c of res?.content ?? []) {
      if (c?.type === "text") parts.push(String(c.text ?? ""));
      else if (c) parts.push(JSON.stringify(c));
    }
    const text = parts.join("\n") || JSON.stringify(res ?? {});
    if (res?.isError) throw new Error(`MCP tool "${name}" reported an error: ${text.slice(0, 400)}`);
    return text;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    try { this.proc.stdin!.end(); } catch { /* already gone */ }
    this.proc.kill();
  }
}
