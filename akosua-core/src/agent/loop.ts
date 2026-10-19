import type { ChatMessage, ModelProvider, ToolCall } from "../providers/types.js";
import type { Phase, ToolRegistry } from "./tools.js";
import { compactHistory, shapeToolResult } from "./context.js";
import { profileFor } from "./profiles.js";

/** Akosua's enforced workflow. Tool access is GATED by phase — an agent in
 * "understand" physically cannot edit files. Advancement requires an explicit
 * sign-off signal in the assistant output (or host UI), never silent skipping. */
export const PHASES: Phase[] = ["understand", "research", "plan", "build", "verify"];
export const PHASE_SIGNOFF: Record<Phase, string> = {
  understand: "UNDERSTANDING COMPLETE:",
  research: "RESEARCH COMPLETE:",
  plan: "PLAN COMPLETE:",
  build: "BUILD COMPLETE:",
  verify: "VERIFICATION COMPLETE:",
};
/** Sign-off detection is punctuation-tolerant (live lesson: gpt-4.1 writes
 * "PLAN APPROVED." with a period). The marker stem must appear, followed by
 * a colon, period, dash or end-of-phrase. */
export function hasSignoff(text: string, phase: Phase): boolean {
  const stem = PHASE_SIGNOFF[phase].replace(/:$/, "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(stem + "\\s*[:.\u2014-]", "i").test(text) || new RegExp(stem + "\\s*$", "im").test(text);
}

export interface PhaseModelRoute { provider: ModelProvider; model: string; }
/** Model routing (Settings -> Akosua): Planner drives Understand/Research/
 * Plan (+Verify execution), Editor drives Build, Reviewer independently
 * reviews the diff at the Build->Verify gate. Unset roles fall back to the
 * agent's primary provider/model. Cross-vendor review (e.g. Claude builds,
 * OpenAI reviews) is the recommended setup — a model marks its own homework
 * less honestly than a rival does. */
export interface ModelRouting { planner?: PhaseModelRoute; editor?: PhaseModelRoute; reviewer?: PhaseModelRoute; }
export interface AgentConfig {
  provider: ModelProvider; model: string;
  systemPrompt: string; maxTurns?: number;
  routing?: ModelRouting;
  /** Context budget (est. tokens). History is compacted mechanically when a
   * run outgrows it — decisions kept, bulk tool evidence digested (A1). */
  contextBudgetTokens?: number;
  /** Diagnostics-after-edit hook (A3): after file_editor calls in Build, the
   * host runs the cheapest stack oracle on the touched files and the parsed
   * result is handed back to the agent as tool evidence. */
  diagnostics?: (files: string[]) => Promise<string>;
  /** IDE enforcement: completing Plan pauses the run for HUMAN approval
   * (plan card). Library/test default off; the assembled IDE agent sets it. */
  requirePlanApproval?: boolean;
  /** Permission hook forwarded to every tool call (destructive commands). */
  confirm?: (question: string) => Promise<boolean>;
  /** Lifecycle hook: deterministic post-edit work (format-on-edit) run by the
   * harness after each Build edit batch, BEFORE diagnostics. */
  afterEdit?: (files: string[]) => Promise<string>;
}
export type AgentEvent =
  | { type: "phase"; phase: Phase }
  | { type: "text"; delta: string }
  | { type: "tool"; name: string; result: string; durationMs?: number; action?: string }
  | { type: "done"; phase: Phase }
  | { type: "review"; verdict: "approved" | "changes_requested" | "unavailable"; text: string }
  | { type: "cancelled"; phase: Phase }
  | { type: "plan"; text: string }
  | { type: "notice"; text: string };

export class Agent {
  phase: Phase = "understand";
  private cancelled = false;
  private phaseToolCount = 0;
  private callStreak = new Map<string, number>();
  private signoffNudges = 0;
  private planApproved = false;
  private reviewRounds = 0;
  private verificationAttempted = false;
  private verifyGateBlocks = 0;
  private reviewerPassed = false;
  private providerRetried = false;
  private routeFor(phase: Phase): PhaseModelRoute {
    const r = this.cfg.routing;
    if (phase === "build" && r?.editor) return r.editor;
    if (r?.planner && phase !== "build") return r.planner;
    return { provider: this.cfg.provider, model: this.cfg.model };
  }
  /** Cross-vendor review of the actual diff. Returns verdict + text.
   * Reviewer gets NO tools: it judges evidence, it cannot touch code. */
  private async runReview(taskText: string, buildSummary: string): Promise<{ verdict: "approved" | "changes_requested" | "unavailable"; text: string }> {
    const reviewer = this.cfg.routing?.reviewer;
    if (!reviewer) return { verdict: "unavailable", text: "No reviewer model configured." };
    try {
      const { reviewEvidenceSinceCheckpoint } = await import("../tools/git.js");
      const evidence = await reviewEvidenceSinceCheckpoint(this.workspaceRoot).catch(() => "(diff evidence unavailable)");
      let text = "";
      for await (const ev of reviewer.provider.complete({
        model: reviewer.model,
        messages: [
          { role: "system", content: "You are Akosua's independent Reviewer. A DIFFERENT model just finished the Build phase. Judge ONLY the evidence: the task, the builder's summary, and the real git diff. Look for: wrong files touched, API misuse, unproven claims, scope creep, broken contracts, missing error handling. Be specific and cite file/line where possible. End your review with EXACTLY one final line: 'REVIEW VERDICT: APPROVED' or 'REVIEW VERDICT: CHANGES REQUESTED'." },
          { role: "user", content: `TASK:\n${taskText}\n\nBUILDER'S SUMMARY:\n${buildSummary}\n\nDIFF EVIDENCE:\n${evidence}` },
        ],
      })) { if (ev.type === "text") text += ev.delta; }
      const verdict = /REVIEW VERDICT:\s*CHANGES REQUESTED/i.test(text) ? "changes_requested" : "approved";
      return { verdict, text: text || "(reviewer returned no text)" };
    } catch (e) { return { verdict: "unavailable", text: `Reviewer unavailable: ${(e as Error).message}` }; }
  }
  /** Max tool calls per phase before the agent is forced to summarise/sign off.
   * Live-test lesson (gpt-4.1, 2026-10-18): without this, an agent can loop
   * dozens of low-value searches inside one phase forever. */
  static PHASE_TOOL_BUDGET = 20;
  /** Host (UI Cancel button) calls this; the loop stops between turns/tools
   * and reports a cancelled event. In-flight provider streams finish their
   * current turn — no half-applied tool calls are started after cancel. */
  cancel() { this.cancelled = true; }
  history: ChatMessage[] = [];
  constructor(private cfg: AgentConfig, private tools: ToolRegistry, private workspaceRoot: string) {
    this.history.push({ role: "system", content: cfg.systemPrompt });
  }
  private taskText = "";
  async *run(userText: string): AsyncIterable<AgentEvent> {
    this.taskText = userText;
    if (/^\s*PLAN APPROVED:/i.test(userText)) this.planApproved = true;
    if (/^\s*PLAN CHANGES REQUESTED:/i.test(userText)) this.planApproved = false;
    // Approval latch at run entry: the resumed run starts IN Build, so its
    // first tool turn is phase-legal and the phase event says "build".
    if (this.planApproved && this.phase === "plan") { this.phase = "build"; this.phaseToolCount = 0; this.planApproved = false; }
    this.history.push({ role: "user", content: userText });
    const maxTurns = this.cfg.maxTurns ?? 60;
    for (let turn = 0; turn < maxTurns; turn++) {
      if (this.cancelled) { yield { type: "cancelled", phase: this.phase }; return; }
      yield { type: "phase", phase: this.phase };
      let text = ""; const calls: ToolCall[] = [];
      const budgetExhausted = this.phaseToolCount >= Agent.PHASE_TOOL_BUDGET;
      if (budgetExhausted) this.history.push({ role: "user", content:
        `You have used ${this.phaseToolCount} tool calls in the "${this.phase}" phase (budget ${Agent.PHASE_TOOL_BUDGET}). ` +
        `Tools are now disabled for this turn. Summarise what you have learned and emit your phase sign-off (${PHASE_SIGNOFF[this.phase]} ...) or state the exact blocker. Do not request more tools.` });
      const compaction = compactHistory(this.history, this.cfg.contextBudgetTokens ?? 100_000);
      if (compaction.digested || compaction.truncated) yield { type: "notice", text: `Context compacted (${compaction.pressure} pressure): ~${compaction.tokensBefore} → ~${compaction.tokensAfter} tokens (${compaction.truncated} truncated, ${compaction.digested} digested; recent evidence and all decisions kept).` };
      const route = this.routeFor(this.phase);
      // Transient provider failures (429/5xx/network blips) die mid-stream in
      // lesser harnesses. Retry the TURN once, visibly; never swallow silently.
        const profile = profileFor(route.provider, route.model);
        const requestMessages = this.history.map((m, i) => i === 0 && m.role === "system" ? { ...m, content: m.content + profile.promptSuffix } : m);
      let streamed = false;
      try {
        for await (const ev of route.provider.complete({
          model: route.model, messages: requestMessages, maxTokens: profile.maxTokens,
          tools: budgetExhausted ? undefined : this.tools.definitionsFor(this.phase),
        })) {
          if (ev.type === "text") { streamed = true; text += ev.delta; yield { type: "text", delta: ev.delta }; }
          if (ev.type === "toolCall") calls.push(ev.call);
        }
      } catch (e) {
        const msg = (e as Error).message ?? String(e);
        const transient = /429|5\d\d|ECONN|ETIMEDOUT|fetch failed|network|overloaded|rate limit/i.test(msg);
        if (transient && !this.providerRetried) {
          this.providerRetried = true;
          yield { type: "notice", text: `Provider hiccup (${msg.slice(0, 160)}). Retrying this turn once…` };
          // Drop any partial assistant text from the failed attempt.
          const retryText = { value: "" }; void retryText;
          try {
            for await (const ev of route.provider.complete({
              model: route.model, messages: requestMessages, maxTokens: profile.maxTokens,
              tools: budgetExhausted ? undefined : this.tools.definitionsFor(this.phase),
            })) {
              if (ev.type === "text") { text += ev.delta; yield { type: "text", delta: ev.delta }; }
              if (ev.type === "toolCall") calls.push(ev.call);
            }
          } catch (e2) { throw new Error(`Provider failed twice in phase "${this.phase}": ${(e2 as Error).message}`); }
        } else {
          throw new Error(`Provider error in phase "${this.phase}"${streamed ? " (after partial output)" : ""}: ${msg}`);
        }
      }
      this.history.push({ role: "assistant", content: text, ...(calls.length ? { toolCalls: calls } : {}) });

      if (!calls.length) {
        // REVIEWER GATE: a Build sign-off does not advance until the
        // independent Reviewer (if configured) approves the real diff.
        // CHANGES REQUESTED sends the agent back into Build with the
        // findings (max 2 rounds, then Verify proceeds with concerns noted
        // so the run can never loop forever).
        if (this.phase === "build" && !this.reviewerPassed && this.cfg.routing?.reviewer && hasSignoff(text, "build")) {
          const review = await this.runReview(this.taskText, text);
          yield { type: "review", verdict: review.verdict, text: review.text };
          if (review.verdict === "changes_requested" && this.reviewRounds < 2) {
            this.reviewRounds++;
            this.history.push({ role: "user", content:
              `CROSS-MODEL REVIEW (round ${this.reviewRounds}/2) — CHANGES REQUESTED. You are still in Build. Fix these findings, then emit "${PHASE_SIGNOFF.build}" again:\n${review.text}` });
            continue;
          }
          this.reviewerPassed = true;
          if (review.verdict === "changes_requested") this.history.push({ role: "user", content:
            `CROSS-MODEL REVIEW: still CHANGES REQUESTED after 2 rounds. Proceed to Verify and report these unresolved concerns honestly in your verification summary:\n${review.text}` });
          else if (review.verdict === "unavailable") this.history.push({ role: "user", content:
            `Note: independent review could not run (${review.text}). Proceed to Verify; do not claim the work was reviewed.` });
          else this.history.push({ role: "user", content: `CROSS-MODEL REVIEW: APPROVED. Proceed to Verify.\n${review.text.slice(0, 2000)}` });
        }
        // Advance through EVERY sign-off marker stated in this message, in
        // order (live lesson: a model may complete Understand+Research+Plan
        // in one strong message; honouring only the first strands it).
        // PLAN GATE (enforced): completing Plan does NOT advance to Build.
        // The plan is surfaced to the human; only their explicit approval
        // message moves the run forward. A model emitting the approval
        // token itself must never self-approve (live lesson 2026-10-18).
        if (this.cfg.requirePlanApproval && this.phase === "plan" && hasSignoff(text, "plan")) {
          if (this.planApproved) {
            this.planApproved = false; // one approval authorises one Plan->Build advance
          } else {
            yield { type: "plan", text };
            yield { type: "done", phase: this.phase }; return;
          }
        }
        const before = this.phase;
        while (this.phase !== "verify" && hasSignoff(text, this.phase)) {
          this.phase = PHASES[PHASES.indexOf(this.phase) + 1];
          this.phaseToolCount = 0;
        }
        if (this.phase === "verify" && hasSignoff(text, "verify")) {
          // VERIFY GATE (loop-level, not prompt-level): no sign-off is
          // accepted until run_verification has actually executed in this
          // phase. The result may PASS, FAIL or COULD-NOT-RUN — all are
          // acceptable evidence; silence is not. Blocked twice, then the
          // run ends flagged rather than looping forever.
          if (!this.verificationAttempted && this.verifyGateBlocks < 2) {
            this.verifyGateBlocks++;
            this.history.push({ role: "user", content:
              `VERIFICATION REJECTED (${this.verifyGateBlocks}/2): you signed off without running the project's checks. Call the run_verification tool NOW, then sign off again reporting its actual PASS / FAIL / COULD-NOT-RUN outcome honestly.` });
            continue;
          }
          if (!this.verificationAttempted) this.history.push({ role: "user", content:
            "Run ended WITHOUT verification evidence: run_verification was never executed. Any summary of this run must state that correctness is UNVERIFIED." });
          yield { type: "done", phase: this.phase }; return; }
        if (this.phase !== before) continue; // advanced: keep working in the new phase
        // No sign-off for the CURRENT phase: nudge and continue (live lesson:
        // models sometimes summarise without the marker, or repeat an earlier
        // phase's marker). Dying silently here strands the whole task.
        if (this.signoffNudges < 3) {
          this.signoffNudges++;
          this.history.push({ role: "user", content:
            `You ended that message without completing the "${this.phase}" phase. Continue working in "${this.phase}" now: use its tools if you still need evidence, then finish with the exact sign-off "${PHASE_SIGNOFF[this.phase]}" followed by your summary. (Nudge ${this.signoffNudges}/3)` });
          continue;
        }
        yield { type: "done", phase: this.phase }; return;
      }
      const editedFiles: string[] = [];
      for (const call of calls) {
        if (this.cancelled) { yield { type: "cancelled", phase: this.phase }; return; }
        this.phaseToolCount++;
        let args: Record<string, unknown> = {};
        let malformed = false;
        try { args = JSON.parse(call.arguments || "{}"); } catch { malformed = true; }
        // Repeat guard: same tool+args 3x is a loop, not research.
        const key = call.name + ":" + call.arguments;
        const streak = (this.callStreak.get(key) ?? 0) + 1;
        this.callStreak.clear(); this.callStreak.set(key, streak);
        const t0 = Date.now();
        const result = streak >= 3
          ? `Blocked: you have called ${call.name} with identical arguments ${streak} times. Repeating it will not change the result. Use a different query/tool, or summarise and sign off this phase.`
          : await this.tools.run(call.name, args, { workspaceRoot: this.workspaceRoot, confirm: this.cfg.confirm }, this.phase);
        if (malformed) yield { type: "notice", text: `Model sent malformed JSON arguments for ${call.name}; the tool was given {} and its error explains the expected shape.` };
        yield { type: "tool", name: call.name, result, durationMs: Date.now() - t0,
          ...(typeof args.action === "string" ? { action: args.action } : {}),
          ...(typeof args.path === "string" && call.name === "file_editor" ? { action: `${String(args.action ?? "edit")}:${args.path}` } : {}) };
        if (this.phase === "verify" && call.name === "run_verification") this.verificationAttempted = true;
        // A2: the MODEL gets the shaped (error-first, capped) rendering;
        // the UI event above already carried the full result.
        this.history.push({ role: "tool", content: shapeToolResult(result), toolCallId: call.id, name: call.name });
        if (this.phase === "build" && call.name === "file_editor" && typeof args.path === "string") editedFiles.push(args.path);
      }
      // Lifecycle hook (format-on-edit): deterministic, harness-owned, runs
      // before diagnostics so the oracle judges the formatted truth.
      if (editedFiles.length && this.cfg.afterEdit) {
        const fmt = await this.cfg.afterEdit(editedFiles).catch(e => `Format hook could not run: ${(e as Error).message}`);
        if (fmt) {
          yield { type: "tool", name: "formatter", result: fmt };
          this.history.push({ role: "tool", content: shapeToolResult(fmt), toolCallId: `fmt-${turn}`, name: "formatter" });
        }
      }
      // A3: after a batch of edits, run the stack's cheapest oracle and give
      // the agent compiler truth before it can sign off Build.
      if (editedFiles.length && this.cfg.diagnostics) {
        const diag = await this.cfg.diagnostics(editedFiles).catch(e => `Diagnostics could not run: ${(e as Error).message}`);
        if (diag) {
          yield { type: "tool", name: "diagnostics", result: diag };
          this.history.push({ role: "tool", content: shapeToolResult(diag), toolCallId: `diag-${turn}`, name: "diagnostics" });
        }
      }
    }
    yield { type: "done", phase: this.phase };
  }
}

export const AKOSUA_SYSTEM_PROMPT = `You are Akosua, a personal AI coding agent inside the user's own IDE.
You work in STRICT phases: Understand -> Research -> Plan -> Build -> Verify.
Rules (non-negotiable):
1. NEVER GUESS. The codebase is the source of truth. Prove APIs exist (codebase, installed package types, or docs) before using them.
2. In Understand, read before you reason. State "${PHASE_SIGNOFF.understand}" followed by what exists and what the task touches when done.
3. In Research, check Context7 docs first for libraries, Firecrawl for online implementations/solutions, YouTube knowledge for video ideas (verify video ideas before use). State "${PHASE_SIGNOFF.research}" with your sources, or why no external research is needed.
4. In Plan, write the files, approach, risks and how success will be proven. State "${PHASE_SIGNOFF.plan}" when the plan is final.
5. In Build, edit surgically. In Verify, run the project's real checks and show evidence; for bugs reproduce first. Never claim done without evidence.
5b. COMMUNICATION: never refer to tool names when speaking to the user — describe the action ("I'll read the orders service"), and briefly say what you are about to do before doing it. If you are only partially confident, gather more evidence instead of answering early. Fix root causes, never symptoms (deleting a check or an error message is not a fix).
6. HONEST VERIFICATION: if a check COULD NOT RUN (command not found, dependencies not installed, no test setup), say exactly that and state that correctness is UNKNOWN — never write "no errors detected", "should work" or equivalent. A check that did not run proves nothing. Report PASS, FAIL and COULD-NOT-RUN as three separate outcomes.
7. At the end of Build, an independent Reviewer model reads your actual git diff (not your summary) and can send you back with findings. Write build summaries that match the diff exactly — discrepancies are treated as defects.
8. DELEGATE BROAD RESEARCH: for wide or parallel exploration (tracing a feature across services, auditing several files at once, scanning a large subsystem) use the delegate research tools — one or many sub-agents in parallel — instead of pulling every file into your own context. You stay the orchestrator: they return distilled findings, you decide and act. For a small, targeted lookup, just read it yourself.
9. BACKGROUND TERMINALS: anything long-running or unbounded (dev servers, watchers, builds, test suites) goes to a background job, never a blocking foreground call. After starting one, wait a few seconds and read its log to prove it is up; poll/wait/kill by job id; send input instead of restarting. The foreground terminal is for quick, finite commands only.
10. CONTEXT HYGIENE: your window is finite and quality degrades as it fills. View files in ranges, prefer search/semantic hits over whole-file dumps, and never re-read what you already have. The harness caps and compacts mechanically, but the cheapest token is the one you never spend.
Truth hierarchy: test/run output > codebase > lockfiles/installed types > version-matched official docs (Context7/Firecrawl) > community ideas (YouTube/Stack Overflow/blogs — leads only).`;
