import type { StackFingerprint } from "./fingerprint.js";
import type { Tool } from "../agent/tools.js";

export interface CommandResult { command: string; exitCode: number; output: string; }
export interface VerifyReport { passed: boolean; results: CommandResult[]; summary: string; }
export type Executor = (command: string, cwd: string) => Promise<{ output: string; exitCode: number }>;

/** Run the fingerprinted verify+test commands. "Done" requires evidence:
 * this report IS the evidence. Output is truncated per command so a failing
 * build can't flood the agent's context. */
export async function runVerification(fp: StackFingerprint, root: string, exec: Executor, maxChars = 6000): Promise<VerifyReport> {
  const commands = [...new Set([...fp.verifyCommands, ...fp.testCommands])];
  const results: CommandResult[] = [];
  for (const command of commands) {
    const { output, exitCode } = await exec(command, root);
    results.push({ command, exitCode, output: output.length > maxChars ? output.slice(0, maxChars) + "\n…[truncated]" : output });
  }
  // No commands detected is COULD-NOT-RUN, never a pass: an empty `every`
  // would otherwise report PASSED with zero evidence (audit finding).
  const passed = results.length > 0 && results.every(r => r.exitCode === 0);
  const summary = results.map(r => `${r.exitCode === 0 ? "PASS" : "FAIL"}  ${r.command}`).join("\n")
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
    return `Verification ${r.passed ? "PASSED" : "FAILED"}:\n${r.summary}\n\n` +
      r.results.map(x => `--- ${x.command} (exit ${x.exitCode}) ---\n${x.output}`).join("\n");
  },
});
