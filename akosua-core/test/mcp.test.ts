import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { McpClient } from "../src/mcp/client.js";
import { ToolRegistry } from "../src/agent/tools.js";

const FAKE_SERVER = `
let buf = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", d => {
  buf += d;
  let i;
  while ((i = buf.indexOf("\\n")) >= 0) {
    const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
    if (!line) continue;
    const msg = JSON.parse(line);
    const reply = (result) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result }) + "\\n");
    if (msg.method === "initialize") reply({ protocolVersion: "2024-11-05", capabilities: {}, serverInfo: { name: "fake", version: "1" } });
    else if (msg.method === "tools/list") reply({ tools: [{ name: "echo_lookup", description: "Echo a query back", inputSchema: { type: "object", required: ["q"], properties: { q: { type: "string" } } } }] });
    else if (msg.method === "tools/call") reply({ content: [{ type: "text", text: "echo:" + (msg.params.arguments.q ?? "") }] });
  }
});
`;

test("MCP client: connects, lists + names namespaces tools, calls through registry, phase-gated", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "akosua-mcp-"));
  const serverFile = path.join(dir, "fake-mcp.cjs");
  await fs.writeFile(serverFile, FAKE_SERVER);
  const { client, tools } = await McpClient.connect({ name: "fake docs", command: process.execPath, args: [serverFile] });
  try {
    assert.equal(tools.length, 1);
    assert.equal(tools[0].definition.name, "mcp_fake_docs_echo_lookup");
    assert.deepEqual(tools[0].phases, ["understand", "research"], "external tools stay out of Build by default");
    const registry = new ToolRegistry();
    registry.register(tools[0]);
    const out = await registry.run("mcp_fake_docs_echo_lookup", { q: "hello" }, { workspaceRoot: dir }, "research");
    assert.equal(out, "echo:hello");
    const blocked = await registry.run("mcp_fake_docs_echo_lookup", { q: "x" }, { workspaceRoot: dir }, "build");
    assert.match(blocked, /NOT available in the "build" phase/);
  } finally { await client.close(); }
});
