import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { agentNotesTool, readNotes, NOTES_PATH } from "../src/tools/notes.js";

test("notebook: append creates dated bullets, read returns them, file persists", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "akosua-notes-"));
  const ctx = { workspaceRoot: dir } as never;
  const empty = await agentNotesTool.run({ command: "read" }, ctx, "understand");
  assert.match(empty, /empty/);
  const r = await agentNotesTool.run({ command: "append", text: "Orders service: OrderCreated must be idempotent on orderId (past bug)." }, ctx, "build");
  assert.match(r, /Noted/);
  const onDisk = fs.readFileSync(path.join(dir, NOTES_PATH), "utf8");
  assert.match(onDisk, /OrderCreated must be idempotent/);
  const back = await readNotes(dir);
  assert.match(back, /## \d{4}-\d{2}-\d{2}/);
});

test("notebook available in every phase (memory is not a mutation gate)", () => {
  assert.deepEqual(agentNotesTool.phases, ["understand", "research", "plan", "build", "verify"]);
});
