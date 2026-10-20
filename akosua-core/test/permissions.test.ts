import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyCommand } from "../src/agent/permissions.js";
import { terminalTool } from "../src/tools/terminal.js";
import { PersistentTerminal } from "../src/tools/terminal.js";

test("classifier: destructive tiers flagged, normal work untouched", () => {
  for (const c of ["rm -rf build", "git push origin main", "git reset --hard HEAD~1", "Remove-Item -Recurse -Force x", "DROP TABLE users;"])
    assert.equal(classifyCommand(c).tier, "destructive", c);
  for (const c of ["npm test", "git status", "ls -la", "rm file.txt", "git commit -m x"])
    assert.equal(classifyCommand(c).tier, "standard", c);
});

test("terminal tool: destructive blocked without host; runs when human approves", async () => {
  const terminals = new Map<string, PersistentTerminal>();
  const tool = terminalTool(terminals);
  const ctx = { workspaceRoot: "/tmp" } as never;
  const blocked = await tool.run({ command: "rm -rf /tmp/akosua-should-never-exist" }, ctx, "build");
  assert.match(blocked, /Blocked \(permission tier\)/);
  const denied = await tool.run({ command: "rm -rf /tmp/akosua-should-never-exist" },
    { workspaceRoot: "/tmp", confirm: async () => false } as never, "build");
  assert.match(denied, /Blocked by the user/);
  const approved = await tool.run({ command: "echo akosua-perm-ok" },
    { workspaceRoot: "/tmp", confirm: async () => true } as never, "build");
  assert.match(approved, /akosua-perm-ok/);
  for (const t of terminals.values()) await t.close();
});
