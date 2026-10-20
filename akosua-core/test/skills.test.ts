import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { listSkills, renderSkillIndex, skillTool } from "../src/context/skills.js";

test("skills: indexed by trigger line, loaded on demand, unknown names error honestly", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "akosua-skill-"));
  fs.mkdirSync(path.join(dir, ".akosua/skills"), { recursive: true });
  fs.writeFileSync(path.join(dir, ".akosua/skills/add-nest-endpoint.md"),
    "# Skill: when adding a NestJS endpoint in this repo\n1. DTO in dto/. 2. Register in module. 3. Emit event via outbox.\n");
  const skills = await listSkills(dir);
  assert.equal(skills.length, 1);
  assert.match(renderSkillIndex(skills), /add-nest-endpoint: when adding a NestJS endpoint/);
  const loaded = await skillTool.run({ name: "add-nest-endpoint" }, { workspaceRoot: dir });
  assert.match(loaded, /SKILL add-nest-endpoint/);
  assert.match(loaded, /outbox/);
  assert.match(await skillTool.run({ name: "nope" }, { workspaceRoot: dir }), /no skill named/);
});
