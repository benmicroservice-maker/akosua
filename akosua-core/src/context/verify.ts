import type { StackFingerprint } from "./fingerprint.js";
import type { Tool } from "../agent/tools.js";

export interface CommandResult { command: string; exitCode: number; output: string; }
export interface VerifyReport { passed: boolean; results: CommandResult[]; summary: string; }
export type Executor = (command: string, cwd: string) => Promise<{ output: string; exitCode: number }>;

/** Run the fingerprinted verify+test commands. "Done" requires evidence:
 * this report IS the evidence. Output is truncated per command so a failing
 * build can't flood the agent's context. */
export type CommandOutcome = "PASS" | "FAIL" | "COULD-NOT-RUN" | "TIMEOUT";
export const classify = (r: CommandResult): CommandOutcome => {
  if (r.exitCode === 0) return "PASS";
  if (r.exitCode === 124 && r.output.includes("[akosua: timed out")) return "TIMEOUT";
  // Missing tooling (127 / shell not-found phrasing) is not a code failure —
  // it is COULD-NOT-RUN evidence and must be reported as such.
  if (r.exitCode === 127 || /command not found|not recognized as an internal or external|ENOENT/i.test(r.output)) return "COULD-NOT-RUN";
  return "FAIL";
};

export async function runVerification(fp: StackFingerprint, root: string, exec: Executor, maxChars = 6000, timeoutMs = 300_000): Promise<VerifyReport> {
  const commands = [...new Set([...fp.verifyCommands, ...fp.testCommands])];
  const results: CommandResult[] = [];
  for (const command of commands) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const raced = await Promise.race([
      exec(command, root).catch(e => ({ output: String((e as Error).message ?? e), exitCode: 1 })),
      new Promise<{ output: string; exitCode: number }>(res => { timer = setTimeout(() => res({ output: `[akosua: timed out after ${Math.round(timeoutMs / 1000)}s — command may still be running in its terminal; treat result as unknown]`, exitCode: 124 }), timeoutMs); }),
    ]).finally(() => { if (timer) clearTimeout(timer); });
    results.push({ command, exitCode: raced.exitCode, output: raced.output.length > maxChars ? raced.output.slice(0, maxChars) + "\n…[truncated]" : raced.output });
  }
  // No commands detected is COULD-NOT-RUN, never a pass: an empty `every`
  // would otherwise report PASSED with zero evidence (audit finding).
  const passed = results.length > 0 && results.every(r => r.exitCode === 0);
  const summary = results.map(r => `${classify(r).padEnd(13)} ${r.command}`).join("\n")
    || "COULD NOT RUN — no verify/test commands were detected for this project (correctness is UNKNOWN)";
  return { passed, results, summary };
}

export const verifyTool = (fp: StackFingerprint, exec: Executor): Tool => ({
  definition: { name: "run_verification", description: "Run this project's REAL verification commands (typecheck/lint/build/tests detected from its stack fingerprint). You may only declare VERIFICATION COMPLETE when this passes, and you must quote its summary as evidence. For a bug fix, also reproduce the bug first with the terminal tool.",
    parameters: { type: "object", properties: {} } },
  phases: ["verify"],
  run: async (_a, ctx) => {
    const r = await runVerification(fp, ctx.workspaceRoot, exec);
    if (!r.results.length) return `Verification COULD NOT RUN:\n${r.summary}\n\nState this honestly: correctness is UNKNOWN. Do NOT claim the code works.`;
    const couldNotRun = r.results.some(x => classify(x) === "COULD-NOT-RUN" || classify(x) === "TIMEOUT");
    return `Verification ${r.passed ? "PASSED" : couldNotRun && !r.results.some(x => classify(x) === "FAIL") ? "COULD NOT FULLY RUN (some checks unavailable — correctness partly UNKNOWN)" : "FAILED"}:\n${r.summary}\n\n` +
      r.results.map(x => `--- ${x.command} (exit ${x.exitCode}) ---\n${x.output}`).join("\n");
  },
});
