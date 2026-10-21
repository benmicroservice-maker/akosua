/** Intent lanes (harness rebuild, 2026-10-20). The old harness ran EVERY
 * message through Understand→Research→Plan→Build→Verify: "how are you"
 * got a five-phase ceremony and "start this app" got 13 turns of reading
 * before it was allowed to act. Production harnesses route per prompt
 * (OpenDev: plan-vs-execute is a one-time decision per prompt; Claude
 * Code: plan mode is opt-in per task). Akosua lanes:
 *  - chat: conversation, no workspace work. One model call, no tools,
 *    no phases. Greetings, thanks, identity, small talk.
 *  - ask: read-only questions about the code/world. Understand tools
 *    only (eyes, never hands), first complete answer ends the run.
 *    No research/plan/build ceremony, no plan-approval gate.
 *  - act: anything that changes files, runs commands, or must be
 *    verified. The full phased harness with its gates.
 * The classifier is deterministic and conservative: chat requires a
 * near-exact small-talk shape; act wins whenever an action verb leads;
 * anything ambiguous falls to act (the safest lane — it can still
 * answer, the others cannot edit). Host-appended context blocks
 * ("# Editor context …") are stripped before classifying. */
export type IntentLane = "chat" | "ask" | "act";
export type ActKind = "execute" | "change";
export interface Intent { lane: IntentLane; reason: string; actKind?: ActKind }

const CHAT_EXACT = /^(hi+|hello|hey+|yo|good\s+(morning|afternoon|evening|day)|how\s+are\s+you(\s+doing)?|how'?s\s+it\s+going|what'?s\s+up|thanks?(\s+a\s+lot)?|thank\s+you|ok(ay)?|yes|yeah|no|nope|cool|great|nice|awesome|perfect|who\s+are\s+you|what\s+are\s+you|what\s+can\s+you\s+do|tell\s+me\s+about\s+yourself|bye|goodbye|good\s+night)[\s!.?]*$/i;
const ACTION_LEAD = /^(please\s+)?(let\s+(me\s+|us\s+)?\w*|fix|create|add|implement|build|run|start|stop|restart|change|update|edit|write|delete|remove|refactor|rename|move|install|uninstall|upgrade|downgrade|deploy|test|debug|check|verify|make|generate|set\s*up|setup|configure|migrate|convert|optimise|optimize|improve|resolve|handle|introduce|replace|revert|undo|commit|push|launch|open|close|kill|restart|initialise|initialize|scaffold|bootstrap)\b/i;
const ACTION_ANYWHERE = /\b(fix|create|add|implement|build|run|start|change|update|edit|write|delete|remove|refactor|install|deploy|generate|migrate|replace)\b/i;
const QUESTION_LEAD = /^(what|why|how|where|when|who|which|whose|explain|describe|show|tell|list|find|search|look|is|are|was|were|does|did|can|could|should|would|compare|summarise|summarize|review|analyse|analyze|trace|walk)\b/i;

export function classifyIntent(raw: string): Intent {
  const text = String(raw ?? "")
    .split(/\n# (Editor context|Context from)/i)[0] // strip host-appended blocks
    .trim();
  const firstLine = text.split("\n")[0].trim()
    .replace(/^(so|ok(ay)?|well|now|please)[,\s]+/i, "")
    .replace(/^let'?s\s+/i, "let ")
    .replace(/^can\s+you\s+/i, "")
    .replace(/^could\s+you\s+(please\s+)?/i, "");
  if (/^\s*PLAN (APPROVED|CHANGES REQUESTED):/i.test(text)) return { lane: "act", reason: "plan-gate response" };
  if (text.length <= 80 && CHAT_EXACT.test(firstLine)) return { lane: "chat", reason: "small-talk shape, no workspace reference" };
  // "get context awareness of this project" is a question wearing an
  // imperative: the deliverable is an overview, not a change. Read-only.
  if (/\b(context awareness|overview|walk me through|tour of)\b/i.test(firstLine) && !/\b(fix|create|edit|change|run|start|install|implement|refactor|delete|remove|add|build|deploy)\b/i.test(firstLine)) return { lane: "ask", reason: "overview/awareness request — read-only answer" };
  if (/\b(then|after that|afterwards)\s+(please\s+)?(fix|create|edit|run|start|install|implement|refactor|delete|remove|add|build|deploy)\b/i.test(firstLine)) return { lane: "act", reason: "explicit sequenced action follows" };
  if (ACTION_LEAD.test(firstLine)) return { lane: "act", reason: "imperative action verb leads" };
  if (/\b(can'?t|cannot|can not|unable to|won'?t|don'?t|doesn'?t|not able to)\b[^.?!]*\b(use|run|open|edit|access|start|do|work)\b/i.test(firstLine)) return { lane: "act", reason: "capability challenge — prove it by doing" };
  const interrogative = QUESTION_LEAD.test(firstLine) || /^do\s+(you|we|i)\b/i.test(firstLine) || /\?\s*$/.test(firstLine);
  if (interrogative && !ACTION_ANYWHERE.test(firstLine.replace(/^(how\s+do\s+i|how\s+can\s+i|how\s+to)\s+/i, ""))) {
    return { lane: "ask", reason: "question without an action imperative" };
  }
  if (interrogative && /^(how\s+do\s+i|how\s+can\s+i|how\s+to)\b/i.test(firstLine) && ACTION_ANYWHERE.test(firstLine)) {
    // "how do I run this?" wants an answer, not execution — unless the
    // user clearly asked Akosua to do it ("…for me", "please run").
    if (!/\bfor me\b|\bplease\b/i.test(firstLine)) return { lane: "ask", reason: "how-to question (answer, don't execute)" };
  }
  // Bare fragments ("task", "go") carry no signal either way. Read-only is
  // the safe default: ask can still answer/investigate, and the user can
  // always follow with an imperative. Hosts may force a lane via config.
  return { lane: "ask", reason: "no action signal — read-only default (safe lane)" };
}

/** Sub-kind of an act request: "execute" = run/start/test/install/launch
 * something that already exists (the work is a command + its output);
 * "change" = create/edit/fix/refactor (the work is a diff). Execute tasks
 * get a slimmed harness: tiny read budget, straight to Build. */
const EXECUTE_LEAD = /^(let\s+(me\s+|us\s+)?)?(run|start|launch|restart|stop|test|install|uninstall|deploy|build|serve|boot|spin\s*up|open|execute|npm|npx|yarn|pnpm|flutter|node|python\w?|go|make)\b/i;
export function actKindOf(text: string, lane: IntentLane): ActKind | undefined {
  if (lane !== "act") return undefined;
  const first = String(text ?? "").split("\n")[0].trim().replace(/^(so|ok(ay)?|well|now|please)[,\s]+/i, "").replace(/^let'?s\s+/i, "let ");
  if (EXECUTE_LEAD.test(first) || /^let\s+(me\s+|us\s+)?(run|start|launch|test|install|open|build|serve)\b/i.test(first)) return "execute";
  return "change";
}
