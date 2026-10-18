import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os"; import path from "node:path";
import type { Tool } from "../agent/tools.js";

const git = (cwd: string, args: string[], env?: NodeJS.ProcessEnv) => new Promise<string>((resolve, reject) => {
  execFile("git", args, { cwd, env: { ...process.env, ...env }, maxBuffer: 10 * 1024 * 1024 },
    (e, stdout, stderr) => e ? reject(new Error(`git ${args[0]} failed: ${stderr || e.message}`)) : resolve(stdout.trim()));
});

/** Create a checkpoint of the ENTIRE working tree (incl. untracked files)
 * WITHOUT touching the user's index, working tree or current branch.
 * Technique: temporary index -> write-tree -> commit-tree -> ref under
 * refs/akosua/checkpoints/<timestamp>-<label>. Restore/diff any time with
 * normal git against that ref. This is Akosua's "peace of mind" undo. */
export async function createCheckpoint(root: string, label = "agent-session"): Promise<string> {
  await git(root, ["rev-parse", "--git-dir"]);
  const tmpIndex = path.join(os.tmpdir(), `akosua-index-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  try {
    await git(root, ["add", "-A"], { GIT_INDEX_FILE: tmpIndex });
    const tree = await git(root, ["write-tree"], { GIT_INDEX_FILE: tmpIndex });
    let parent: string[] = [];
    try { parent = ["-p", await git(root, ["rev-parse", "HEAD"])]; } catch { /* first commit */ }
    const commit = await git(root, ["commit-tree", tree, ...parent, "-m", `akosua checkpoint: ${label}`]);
    const ref = `refs/akosua/checkpoints/${new Date().toISOString().replace(/[:.]/g, "-")}-${label.replace(/[^a-z0-9-]+/gi, "-")}`;
    await git(root, ["update-ref", ref, commit]);
    return ref;
  } finally { await fs.rm(tmpIndex, { force: true }); }
}
export async function listCheckpoints(root: string): Promise<string[]> {
  const out = await git(root, ["for-each-ref", "--format=%(refname)", "refs/akosua/checkpoints/"]);
  return out ? out.split("\n").filter(Boolean) : [];
}
export async function diffSinceCheckpoint(root: string, ref: string): Promise<string> {
  return (await git(root, ["diff", "--stat", `${ref}`, "--", "."])) || "(no tracked-file changes since checkpoint)";
}

/** One checkpoint per agent session (live-test lesson: gpt-4.1 created 7).
 * The factory holds the session's ref; repeat calls return it instead of
 * piling up near-identical checkpoints. The undo point stays unambiguous. */
export function createGitCheckpointTool(): Tool {
  let existing: string | undefined;
  return {
    definition: { name: "git_checkpoint", description: "Create THE safety checkpoint of the whole working tree for this session (call ONCE, at the start of Build). Does NOT alter the user's branch, index or files. Repeat calls return the same ref — one checkpoint per session is the rule; it is the undo point.",
      parameters: { type: "object", properties: { label: { type: "string" } } } },
    phases: ["plan", "build"],
    run: async (a, ctx) => {
      if (existing) return `Checkpoint already created for this agent session: ${existing}. One checkpoint per session — reuse this ref as the undo point; do not create more.`;
      existing = await createCheckpoint(ctx.workspaceRoot, String(a.label ?? "agent-session"));
      return `Checkpoint created: ${existing}. If anything goes wrong we can diff/restore against this ref.`;
    },
  };
}
export const gitCheckpointTool: Tool = createGitCheckpointTool();

/** Akosua keeps state (research cache, indexes) in <workspace>/.akosua/.
 * It must never pollute the user's git status: ensure .akosua/ is ignored
 * in git projects. No-op outside git repos; idempotent. */
export async function ensureAkosuaStateIgnored(root: string): Promise<void> {
  try { await fs.stat(path.join(root, ".git")); } catch { return; }
  const file = path.join(root, ".gitignore");
  let current = "";
  try { current = await fs.readFile(file, "utf8"); } catch { /* create below */ }
  const lines = current.split(/\r?\n/).map(l => l.trim());
  if (lines.includes(".akosua/") || lines.includes(".akosua")) return;
  const block = `${current && !current.endsWith("\n") ? "\n" : ""}# Akosua local state (research cache, indexes)\n.akosua/\n`;
  await fs.writeFile(file, current + block);
}

/** Diff stat + restore for the review UI. Restore returns the working tree
 * to EXACTLY the checkpoint: tracked files restored from the ref, and files
 * created after the checkpoint (not present in its tree) are removed.
 * The user's current branch/index are not moved (restore touches worktree
 * + index contents via git restore, which is the review action itself). */
export async function restoreCheckpoint(root: string, ref: string): Promise<string> {
  const inTree = new Set((await git(root, ["ls-tree", "-r", "--name-only", ref])).split("\n").filter(Boolean));
  await git(root, ["restore", "--source", ref, "--staged", "--worktree", "--", "."]);
  // remove files that did not exist at checkpoint time
  const status = await git(root, ["status", "--porcelain"]);
  for (const line of status.split("\n").filter(Boolean)) {
    const file = line.slice(3).trim();
    if (file && !inTree.has(file)) await fs.rm(path.join(root, file), { force: true });
  }
  return `Restored working tree to ${ref}`;
}

/** Evidence pack for the cross-vendor Reviewer: what changed since the
 * session checkpoint (stat + truncated diff + untracked list). Reviewers
 * judge real diffs, not the builder's claims about them. */
export async function reviewEvidenceSinceCheckpoint(root: string, maxChars = 12000): Promise<string> {
  const refs = await listCheckpoints(root).catch(() => [] as string[]);
  if (!refs.length) return "(no git checkpoint available — review the build summary with extra scepticism, file contents were not independently diffed)";
  const ref = refs[refs.length - 1];
  const stat = await git(root, ["diff", "--stat", ref, "--", "."]).catch(() => "");
  const diff = await git(root, ["diff", ref, "--", "."]).catch(() => "");
  const status = await git(root, ["status", "--porcelain"]).catch(() => "");
  const untracked = status.split("\n").filter(l => l.startsWith("??")).map(l => l.slice(3).trim()).filter(Boolean);
  return `Checkpoint: ${ref}\nChanged (stat):\n${stat || "(none)"}\nUntracked new files: ${untracked.join(", ") || "(none)"}\nDiff (truncated):\n${(diff || "(no tracked diff)").slice(0, maxChars)}`;
}
