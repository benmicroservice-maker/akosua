import * as fs from "node:fs";
import * as path from "node:path";

/**
 * Flight Recorder — Akosua's answer to "the developers can't see what the
 * IDE actually did on the user's machine". Every harness decision lands in
 * `.akosua/diagnostics/session-<id>.jsonl` as structured, redacted JSONL,
 * and `buildDiagnosticsBundle()` folds the sessions + `.akosua/runs/`
 * artifacts + a human summary into ONE shareable `.json` file the user can
 * hand back. Design rules:
 *  - NEVER throws: a broken recorder must not break the agent. All public
 *    methods swallow errors.
 *  - NEVER records secrets: keys/tokens are redacted by key-name AND by
 *    value-shape (sk-…, github_pat_…, Bearer …, JWTs) before anything is
 *    written. The host passes only has-key booleans in metadata.
 *  - BOUNDED: per-field caps, per-file rotation, bundle keeps the newest
 *    sessions only. A week of dogfooding must stay emailable.
 *  - Append-only JSONL: a crash mid-run loses nothing already written.
 */

export interface FlightEvent {
  ts: string;
  seq: number;
  session: string;
  type: string;
  data: Record<string, unknown>;
}

export interface FlightRecorderOptions {
  /** Total cap for one session file before rotating to `-p2`, `-p3`, … */
  maxFileBytes?: number;
  /** Preview chars kept for tool results / assistant text. 20k default:
   * the bundle is read by developers reconstructing a run, not emailed
   * byte-counted — losing the middle of a diff costs more than bytes. */
  maxPreview?: number;
  /** Injectable clock for tests. */
  now?: () => Date;
}

const DEFAULT_MAX_FILE_BYTES = 10 * 1024 * 1024;
const DEFAULT_PREVIEW = 20_000;

/** Key names whose values are always secrets, wherever they appear. */
const SECRET_KEY = /(api[-_]?key|apikey|authorization|secret|password|passwd|credential|access[-_]?token|refresh[-_]?token|private[-_]?key)/i;

/** Value shapes that are secrets even under innocent key names. */
const SECRET_VALUE: [RegExp, string][] = [
  [/sk-[A-Za-z0-9_-]{8,}/g, "sk-[REDACTED]"],
  [/github_pat_[A-Za-z0-9_]{8,}/g, "github_pat_[REDACTED]"],
  [/gh[pousr]_[A-Za-z0-9]{8,}/g, "gh_[REDACTED]"],
  [/Bearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, "Bearer [REDACTED]"],
  [/eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{6,}/g, "[JWT REDACTED]"],
  [/AKIA[A-Z0-9]{16}/g, "AKIA[REDACTED]"],
];

function redactString(s: string): string {
  let out = s;
  for (const [re, sub] of SECRET_VALUE) out = out.replace(re, sub);
  return out;
}

/**
 * Deep-redact + bound an arbitrary value for the flight log. Strings are
 * secret-scrubbed and (optionally) preview-truncated with an explicit
 * marker; object keys that look secret have their values replaced before
 * recursion; depth/array/object sizes are capped so one pathological tool
 * result cannot bloat the log. Exported for tests and host reuse.
 */
export function redactForFlightLog(value: unknown, opts: { maxString?: number; depth?: number } = {}): unknown {
  const maxString = opts.maxString ?? 4_000;
  const walk = (v: unknown, depth: number): unknown => {
    if (typeof v === "string") {
      const clean = redactString(v);
      return clean.length > maxString ? `${clean.slice(0, maxString)}…[truncated ${clean.length - maxString} chars]` : clean;
    }
    if (v === null || typeof v === "number" || typeof v === "boolean") return v;
    if (v instanceof Error) return { error: v.name, message: redactString(v.message), stack: v.stack ? redactString(v.stack).slice(0, 2_000) : undefined };
    if (depth >= 6) return "[max depth]";
    if (Array.isArray(v)) return v.slice(0, 50).map(x => walk(x, depth + 1));
    if (typeof v === "object") {
      const out: Record<string, unknown> = {};
      for (const [k, val] of Object.entries(v as Record<string, unknown>).slice(0, 60)) {
        out[k] = SECRET_KEY.test(k) ? "[REDACTED]" : walk(val, depth + 1);
      }
      return out;
    }
    return String(v);
  };
  return walk(value, 0);
}

/** Public list prices (USD per 1M tokens, Oct 2026) for the cost ESTIMATE
 * in summaries. Keyed by model-id substring; unknown models get no stamp
 * (Akosua never guesses). Estimate only - the token counts are the truth. */
const MODEL_PRICES: { match: string; inputPerM: number; outputPerM: number }[] = [
  { match: "gpt-6.1", inputPerM: 2.0, outputPerM: 8.0 },
  { match: "gpt-6", inputPerM: 2.0, outputPerM: 8.0 },
  { match: "gpt-5", inputPerM: 1.25, outputPerM: 10.0 },
  { match: "claude-opus", inputPerM: 15.0, outputPerM: 75.0 },
  { match: "claude-sonnet", inputPerM: 3.0, outputPerM: 15.0 },
  { match: "claude-haiku", inputPerM: 0.8, outputPerM: 4.0 },
];
export function priceForModel(model: string): { inputPerM: number; outputPerM: number } | undefined {
  const m = model.toLowerCase();
  return MODEL_PRICES.find(p => m.includes(p.match));
}

/** Stable short hash of tool-call arguments (loop detection in summaries:
 * the same tool called with identical args repeatedly is a stuck agent). */
export function hashToolArgs(args: unknown): string {
  try {
    const stable = (v: unknown): unknown => {
      if (Array.isArray(v)) return v.map(stable);
      if (v && typeof v === "object") return Object.fromEntries(Object.entries(v as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([k, x]) => [k, stable(x)]));
      return v;
    };
    const text = typeof args === "string" ? args : JSON.stringify(stable(args ?? {}));
    let h = 0; for (let i = 0; i < text.length; i++) h = ((h << 5) - h + text.charCodeAt(i)) | 0;
    return (h >>> 0).toString(36);
  } catch { return "?"; }
}

/** Tool-result failure heuristic shared by summary + report. Tool results in
 * Akosua are strings; failures announce themselves. Kept deliberately
 * conservative — the raw preview is always in the log for a human verdict. */
export function looksLikeFailure(result: unknown): boolean {
  if (typeof result !== "string") return false;
  return /^(error|failed|failure|blocked|exception)\b/i.test(result.trim())
    || /\berror:/i.test(result)
    || /\b(command not found|enoent|eacces|timed out|exit code [1-9]|error TS\d|✗|FAILED)\b/i.test(result)
    || /npm err!/i.test(result);
}

export interface RunSummary {
  runs: number;
  runDurationsMs: number[];
  runOutcomes: Record<string, number>;
  turns: number;
  toolCalls: number;
  toolFailures: number;
  toolsByName: Record<string, { calls: number; failures: number; totalMs: number }>;
  phases: Record<string, number>;
  compactions: number;
  notices: number;
  noticeTexts: string[];
  providerErrors: number;
  providerRetries: number;
  reviews: Record<string, number>;
  gates: { gate: string; outcome: string }[];
  modelUsage: Record<string, { calls: number; inputTokens: number; outputTokens: number; cachedInputTokens: number; totalMs: number }>;
  inputTokens: number;
  outputTokens: number;
  loops: { tool: string; argsHash: string; count: number }[];
  estimatedCostUSD: number;
  ttftMsAvg?: number;
  stuckSignals: string[];
  slowestTools: { name: string; durationMs: number; turn?: number }[];
  subagents: number;
  filesChanged: string[];
  annotations: { ts: string; text: string }[];
  errors: { ts: string; text: string }[];
  firstTs?: string;
  lastTs?: string;
}

/** Fold flight events (any sessions, in order) into run-level statistics. */
export function summarizeFlightEvents(events: readonly FlightEvent[]): RunSummary {
  const s: RunSummary = {
    runs: 0, runDurationsMs: [], runOutcomes: {}, turns: 0, toolCalls: 0, toolFailures: 0,
    toolsByName: {}, phases: {}, compactions: 0, notices: 0, noticeTexts: [], providerErrors: 0,
    providerRetries: 0, reviews: {}, gates: [], modelUsage: {}, inputTokens: 0, outputTokens: 0,
    loops: [], slowestTools: [], subagents: 0, filesChanged: [], annotations: [], errors: [],
    estimatedCostUSD: 0, stuckSignals: [],
  };
  const changed = new Set<string>();
  const argCounts = new Map<string, { tool: string; argsHash: string; count: number }>();
  const slowest: { name: string; durationMs: number; turn?: number }[] = [];
  let ttftSum = 0; let ttftN = 0; let openRuns = 0;
  for (const ev of events) {
    s.firstTs ??= ev.ts; s.lastTs = ev.ts;
    const d = ev.data ?? {};
    switch (ev.type) {
      case "run.start": s.runs++; openRuns++; break;
      case "run.end": {
        if (typeof d.durationMs === "number") s.runDurationsMs.push(d.durationMs);
        const o = typeof d.outcome === "string" ? d.outcome : "done";
        s.runOutcomes[o] = (s.runOutcomes[o] ?? 0) + 1;
        openRuns = Math.max(0, openRuns - 1);
        if (d.turnsExhausted) s.stuckSignals.push("a run exhausted its turn budget without finishing");
        break;
      }
      case "model.response": {
        const key = `${String(d.provider ?? "?")}/${String(d.responseModel ?? d.model ?? "?")}`;
        const m = (s.modelUsage[key] ??= { calls: 0, inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, totalMs: 0 });
        m.calls++;
        if (typeof d.ttftMs === "number") { ttftSum += d.ttftMs; ttftN++; }
        const u = (d.usage ?? {}) as { inputTokens?: number; outputTokens?: number; cachedInputTokens?: number };
        const price = priceForModel(String(d.responseModel ?? d.model ?? ""));
        if (price) s.estimatedCostUSD += ((u.inputTokens ?? 0) * price.inputPerM + (u.outputTokens ?? 0) * price.outputPerM) / 1_000_000;
        m.inputTokens += u.inputTokens ?? 0; m.outputTokens += u.outputTokens ?? 0; m.cachedInputTokens += u.cachedInputTokens ?? 0;
        s.inputTokens += u.inputTokens ?? 0; s.outputTokens += u.outputTokens ?? 0;
        if (typeof d.durationMs === "number") m.totalMs += d.durationMs;
        break;
      }
      case "provider.retry": s.providerRetries++; s.providerErrors++; break;
      case "gate": s.gates.push({ gate: String(d.gate ?? "?"), outcome: String(d.outcome ?? "?") }); break;
      case "subagent.start": s.subagents++; break;
      case "turn.start": s.turns++; break;
      case "phase": if (typeof d.phase === "string") s.phases[d.phase] = (s.phases[d.phase] ?? 0) + 1; break;
      case "tool": {
        s.toolCalls++;
        const name = typeof d.name === "string" ? d.name : "?";
        const t = (s.toolsByName[name] ??= { calls: 0, failures: 0, totalMs: 0 });
        t.calls++; if (typeof d.durationMs === "number") t.totalMs += d.durationMs;
        if (d.ok === false || looksLikeFailure(d.resultPreview) || looksLikeFailure(d.result)) { s.toolFailures++; t.failures++; }
        if (d.args !== undefined) {
          const h = hashToolArgs(d.args);
          const k = `${name}:${h}`;
          const rec = (argCounts.get(k) ?? { tool: name, argsHash: h, count: 0 });
          rec.count++; argCounts.set(k, rec);
        }
        if (typeof d.durationMs === "number") slowest.push({ name, durationMs: d.durationMs, turn: typeof d.turn === "number" ? d.turn : undefined });
        break;
      }
      case "context.compaction": s.compactions++; break;
      case "notice": s.notices++; if (s.noticeTexts.length < 20) s.noticeTexts.push(String(d.text ?? "").slice(0, 240)); if (/provider|hiccup|retry/i.test(String(d.text ?? ""))) s.providerErrors++; break;
      case "review": if (typeof d.verdict === "string") s.reviews[d.verdict] = (s.reviews[d.verdict] ?? 0) + 1; break;
      case "changeset": if (Array.isArray(d.files)) for (const f of d.files) changed.add(typeof f === "string" ? f : String((f as { path?: unknown })?.path ?? f)); break;
      case "user.annotation": s.annotations.push({ ts: ev.ts, text: String(d.text ?? "") }); break;
      case "error": s.errors.push({ ts: ev.ts, text: String(d.message ?? d.text ?? "?") }); break;
    }
  }
  s.filesChanged = [...changed].sort();
  s.loops = [...argCounts.values()].filter(x => x.count >= 3).sort((a, b) => b.count - a.count).slice(0, 10);
  if (openRuns > 0) s.stuckSignals.push(`${openRuns} run(s) started with no run.end - crashed, killed, or still running at export`);
  for (const [name, t] of Object.entries(s.toolsByName)) if (t.calls >= 3 && t.failures / t.calls >= 0.5) s.stuckSignals.push(`tool ${name} failed ${t.failures}/${t.calls} times`);
  if (ttftN) s.ttftMsAvg = Math.round(ttftSum / ttftN);
  s.slowestTools = slowest.sort((a, b) => b.durationMs - a.durationMs).slice(0, 5);
  return s;
}

function fmtMs(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "?";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const sec = ms / 1000;
  if (sec < 60) return `${sec.toFixed(1)}s`;
  const m = Math.floor(sec / 60);
  return `${m}m ${Math.round(sec % 60)}s`;
}

/** Human-readable report — the first thing a developer reads in the bundle. */
export function renderDiagnosticsReport(events: readonly FlightEvent[], meta: Record<string, unknown> = {}): string {
  const s = summarizeFlightEvents(events);
  const L: string[] = [];
  const runLines: string[] = [];
  {
    let cur: { task: string; turns: number; tools: number; fails: number } | undefined;
    for (const ev of events) {
      const d = ev.data ?? {};
      if (ev.type === "run.start") cur = { task: String(d.task ?? "").split("\n")[0].slice(0, 110), turns: 0, tools: 0, fails: 0 };
      else if (cur && ev.type === "turn.start") cur.turns++;
      else if (cur && ev.type === "tool") { cur.tools++; if (d.ok === false) cur.fails++; }
      else if (cur && ev.type === "run.end") {
        runLines.push(`- "${cur.task}" -> ${String(d.outcome ?? "done")} in ${fmtMs(typeof d.durationMs === "number" ? d.durationMs : NaN)} (${cur.turns} turns, ${cur.tools} tools, ${cur.fails} failed)`);
        cur = undefined;
      }
    }
    if (cur) runLines.push(`- "${cur.task}" -> (no run.end recorded - crashed or still running) (${cur.turns} turns, ${cur.tools} tools)`);
  }
  L.push("# Akosua Diagnostics Report");
  L.push("");
  L.push(`- Generated: ${new Date().toISOString()}`);
  if (meta.appVersion) L.push(`- Akosua version: ${String(meta.appVersion)}`);
  if (meta.vscodeVersion) L.push(`- Editor version: ${String(meta.vscodeVersion)}`);
  if (meta.platform) L.push(`- Platform: ${String(meta.platform)}`);
  if (meta.workspaceName) L.push(`- Workspace: ${String(meta.workspaceName)}`);
  if (s.firstTs) L.push(`- Log window: ${s.firstTs} → ${s.lastTs ?? s.firstTs}`);
  L.push("");
  L.push("## Run summary");
  L.push("");
  L.push(`- Runs: **${s.runs}** · Turns (model calls): **${s.turns}** · Tool calls: **${s.toolCalls}** (${s.toolFailures} failed)`);
  if (s.runDurationsMs.length) L.push(`- Run durations: ${s.runDurationsMs.map(fmtMs).join(", ")}`);
  if (Object.keys(s.phases).length) L.push(`- Phases visited: ${Object.entries(s.phases).map(([k, v]) => `${k}×${v}`).join(", ")}`);
  if (Object.keys(s.runOutcomes).length) L.push("- Run outcomes: " + Object.entries(s.runOutcomes).map(([k, v]) => k + " \u00d7" + v).join(", "));
  if (s.gates.length) L.push("- Gates: " + s.gates.map(g => g.gate + ":" + g.outcome).join(", "));
  L.push("- Tokens: **" + s.inputTokens.toLocaleString() + " in / " + s.outputTokens.toLocaleString() + " out** (provider-reported; 0 = provider did not report usage)");
  L.push(`- Context compactions: ${s.compactions} · Notices: ${s.notices} · Provider retries: ${s.providerRetries} · Sub-agents: ${s.subagents}`);
  if (Object.keys(s.reviews).length) L.push(`- Reviewer verdicts: ${Object.entries(s.reviews).map(([k, v]) => `${k}×${v}`).join(", ")}`);
  L.push("");
  if (runLines.length) {
    L.push("## Runs (in order)");
    L.push("");
    for (const r of runLines.slice(0, 30)) L.push(r);
    L.push("");
  }
  if (Object.keys(s.modelUsage).length) {
    L.push("## Model usage");
    L.push("");
    L.push("| Provider/model | Calls | Input tok | Output tok | Cached | Total time |");
    L.push("|---|---:|---:|---:|---:|---:|");
    for (const [k, m] of Object.entries(s.modelUsage)) L.push("| " + k + " | " + m.calls + " | " + m.inputTokens.toLocaleString() + " | " + m.outputTokens.toLocaleString() + " | " + m.cachedInputTokens.toLocaleString() + " | " + fmtMs(m.totalMs) + " |");
    L.push("");
  }
  if (s.loops.length || s.slowestTools.length || s.stuckSignals.length) {
    L.push("## Suspicious patterns (read these first)");
    L.push("");
    for (const lp of s.loops) L.push("- LOOP: `" + lp.tool + "` called " + lp.count + "x with identical arguments (args hash " + lp.argsHash + ") - the agent may be stuck.");
    for (const st of s.slowestTools) L.push("- SLOW: `" + st.name + "` took " + fmtMs(st.durationMs) + (st.turn !== undefined ? " (turn " + st.turn + ")" : "") + ".");
    for (const sig of s.stuckSignals) L.push("- STUCK?: " + sig + ".");
    L.push("");
  }
  if (s.noticeTexts.length) {
    L.push("## Notices shown to the user");
    L.push("");
    for (const n of s.noticeTexts) L.push("- " + n);
    L.push("");
  }
  if (Object.keys(s.toolsByName).length) {
    L.push("## Tool usage");
    L.push("");
    L.push("| Tool | Calls | Failed | Total time |");
    L.push("|---|---:|---:|---:|");
    for (const [name, t] of Object.entries(s.toolsByName).sort((a, b) => b[1].calls - a[1].calls)) {
      L.push(`| ${name} | ${t.calls} | ${t.failures} | ${fmtMs(t.totalMs)} |`);
    }
    L.push("");
  }
  if (s.filesChanged.length) {
    L.push("## Files changed (change-sets)");
    L.push("");
    for (const f of s.filesChanged.slice(0, 60)) L.push(`- \`${f}\``);
    if (s.filesChanged.length > 60) L.push(`- …and ${s.filesChanged.length - 60} more`);
    L.push("");
  }
  if (s.annotations.length) {
    L.push("## User annotations (\"mark issue\" moments)");
    L.push("");
    for (const a of s.annotations) L.push(`- **${a.ts}** — ${a.text}`);
    L.push("");
  }
  if (s.errors.length) {
    L.push("## Errors");
    L.push("");
    for (const e of s.errors.slice(0, 30)) L.push(`- **${e.ts}** — ${e.text.slice(0, 500)}`);
    L.push("");
  }
  L.push("## How to read the raw log");
  L.push("");
  L.push("Paste THIS report back first - it stands alone for most diagnoses. Attach the sibling .json bundle for the full");
  L.push("turn-by-turn record. Key event types in `events`: `run.start` (task, models, FULL system prompt, tools per phase) ·");
  L.push("`turn.start` (history digest, tools offered) · `model.response` (latency, stop reason, token usage, text, tool calls) ·");
  L.push("`tool` (callId, args, ok flag, result) · `phase` · `gate` · `provider.retry` · `context.compaction` · `review(.start/.end)` ·");
  L.push("`subagent.*` · `changeset` · `host.*` · `user.annotation` · `error` · `run.end`.");
  L.push("");
  return L.join("\n");
}

export interface SessionInfo { id: string; file: string; startedAt: string }

/**
 * The loop depends on this one-method interface, not on the file-backed
 * recorder — hosts inject the real `FlightRecorder`; tests inject fakes.
 * Implementations MUST NOT throw (the recorder guards itself; loop calls
 * are additionally wrapped).
 */
export interface FlightTap { record(type: string, data?: Record<string, unknown>): void }

export class FlightRecorder {
  readonly dir: string;
  private seq = 0;
  private written = 0;
  private writeErrors = 0;
  private session: SessionInfo | undefined;
  private part = 1;
  private bytes = 0;
  private readonly maxFileBytes: number;
  private readonly maxPreview: number;
  private readonly now: () => Date;

  constructor(workspaceRoot: string, opts: FlightRecorderOptions = {}) {
    this.dir = path.join(workspaceRoot, ".akosua", "diagnostics");
    this.maxFileBytes = opts.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
    this.maxPreview = opts.maxPreview ?? DEFAULT_PREVIEW;
    this.now = opts.now ?? (() => new Date());
  }

  /** Start a fresh session log file. Returns its id (\"\" if unavailable). */
  startSession(meta: Record<string, unknown> = {}): string {
    try {
      fs.mkdirSync(this.dir, { recursive: true });
      const d = this.now();
      const stamp = d.toISOString().replace(/[:.]/g, "-");
      const id = `${stamp}-${Math.random().toString(36).slice(2, 6)}`;
      this.session = { id, file: path.join(this.dir, `session-${id}.jsonl`), startedAt: d.toISOString() };
      this.part = 1; this.bytes = 0; this.seq = 0;
      this.record("session.start", { ...meta, sessionId: id });
      return id;
    } catch { return ""; }
  }

  get sessionId(): string { return this.session?.id ?? ""; }

  /** Append one event. Data is redacted + preview-bounded before writing. */
  record(type: string, data: Record<string, unknown> = {}): void {
    if (!this.session) return;
    try {
      const bounded: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(data)) {
        bounded[k] = typeof v === "string" && /(result|text|content|preview)/i.test(k)
          ? redactForFlightLog(v, { maxString: this.maxPreview })
          : redactForFlightLog(v);
      }
      const ev: FlightEvent = { ts: this.now().toISOString(), seq: ++this.seq, session: this.session.id, type, data: bounded };
      const line = JSON.stringify(ev) + "\n";
      if (this.bytes + line.length > this.maxFileBytes && this.bytes > 0 && line.length <= this.maxFileBytes) this.rotate();
      fs.appendFileSync(this.currentFile(), line, "utf8");
      this.bytes += line.length;
      this.written++;
    } catch { this.writeErrors++; /* the recorder must never break the agent */ }
  }

  /** Recorder self-health: the export flow records this so a silent
   * recorder failure is itself visible in the bundle. */
  stats(): { written: number; writeErrors: number; session: string; dir: string } {
    return { written: this.written, writeErrors: this.writeErrors, session: this.session?.id ?? "", dir: this.dir };
  }

  /** Read back events from session files (newest `maxFiles`), in order. */
  static readEvents(dir: string, maxFiles = 5): FlightEvent[] {
    try {
      const files = fs.readdirSync(dir)
        .filter(f => /^session-.*\.jsonl$/.test(f))
        .sort()
        .slice(-maxFiles);
      const out: FlightEvent[] = [];
      for (const f of files) {
        for (const line of fs.readFileSync(path.join(dir, f), "utf8").split("\n")) {
          if (!line.trim()) continue;
          try { out.push(JSON.parse(line) as FlightEvent); } catch { /* torn last line after a crash — skip */ }
        }
      }
      return out;
    } catch { return []; }
  }

  /**
   * Build the ONE shareable bundle: metadata + folded report + raw events +
   * recent `.akosua/runs/` artifacts (plans/walkthroughs), all redacted.
   * Writes `<root>/.akosua/diagnostics/akosua-diagnostics-<stamp>.json` and
   * a sibling `.md` with just the human report. Returns both paths.
   */
  static buildBundle(workspaceRoot: string, meta: Record<string, unknown> = {}): { jsonPath: string; mdPath: string; eventCount: number } | undefined {
    try {
      const dir = path.join(workspaceRoot, ".akosua", "diagnostics");
      fs.mkdirSync(dir, { recursive: true });
      const events = FlightRecorder.readEvents(dir, 5);
      const report = renderDiagnosticsReport(events, meta);
      const artifacts: { name: string; content: string }[] = [];
      try {
        const runsDir = path.join(workspaceRoot, ".akosua", "runs");
        const names = fs.readdirSync(runsDir).filter(f => f.endsWith(".md")).sort().slice(-10);
        for (const name of names) {
          const content = fs.readFileSync(path.join(runsDir, name), "utf8");
          artifacts.push({ name, content: String(redactForFlightLog(content, { maxString: 20_000 })) });
        }
      } catch { /* no runs yet */ }
      try {
        const notes = fs.readFileSync(path.join(workspaceRoot, ".akosua", "NOTES.md"), "utf8");
        artifacts.push({ name: "NOTES.md", content: String(redactForFlightLog(notes, { maxString: 10_000 })) });
      } catch { /* no notes */ }
      // Bundle size guard: keep the NEWEST events within ~12MB of JSON so
      // the file stays attachable; the .md report still covers the window.
      let kept = events;
      let eventsDropped = 0;
      const sizeOf = (evs: readonly FlightEvent[]) => evs.reduce((n, e) => n + JSON.stringify(e).length + 1, 0);
      while (kept.length > 1 && sizeOf(kept) > 12 * 1024 * 1024) { kept = kept.slice(Math.ceil(kept.length / 4)); eventsDropped = events.length - kept.length; }
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      const bundle = {
        kind: "akosua-diagnostics",
        version: 2,
        eventsDroppedForSize: eventsDropped,
        generatedAt: new Date().toISOString(),
        meta: redactForFlightLog(meta) as Record<string, unknown>,
        summary: summarizeFlightEvents(events),
        report,
        artifacts,
        events: kept.map(e => ({ ...e, data: redactForFlightLog(e.data) as Record<string, unknown> })),
      };
      const jsonPath = path.join(dir, `akosua-diagnostics-${stamp}.json`);
      const mdPath = path.join(dir, `akosua-diagnostics-${stamp}.md`);
      fs.writeFileSync(jsonPath, JSON.stringify(bundle, null, 2), "utf8");
      fs.writeFileSync(mdPath, report, "utf8");
      return { jsonPath, mdPath, eventCount: kept.length };
    } catch { return undefined; }
  }

  private currentFile(): string {
    if (!this.session) return "";
    return this.part === 1 ? this.session.file : this.session.file.replace(/\.jsonl$/, `-p${this.part}.jsonl`);
  }

  private rotate(): void {
    this.part++;
    this.bytes = 0;
    this.record("session.rotated", { part: this.part });
  }
}
