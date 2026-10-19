import * as vscode from "vscode";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
// @akosua/core is bundled INTO this extension at build time by esbuild
// (see esbuild.mts): VS Code's product packager cannot resolve a runtime
// dependency that lives outside extensions/, so the core travels inside
// dist/extension.js. The module is declared in core-shim.d.ts (untyped here
// by design — the core's own test suite owns its correctness).
import * as coreBundled from "@akosua/core";
const addDecoration = vscode.window.createTextEditorDecorationType({
  isWholeLine: true, backgroundColor: new vscode.ThemeColor("diffEditor.insertedLineBackground"),
  overviewRulerColor: new vscode.ThemeColor("diffEditor.insertedTextBorder"),
});
interface SecretStore { get(k: string): Promise<string | undefined>; set(k: string, v: string): Promise<void>; delete(k: string): Promise<void>; }
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type CoreModule = any;
const core: CoreModule = coreBundled;
import { PROVIDERS, specFor, maskedStatus, parseMcpServers, type ProviderId } from "./config.js";
import { settingsHtml } from "./settings.js";

/** Bridges VS Code SecretStorage (Windows Credential Manager on Windows)
 * to the core SecretStore interface. This is the ONLY place keys live. */
class VsCodeSecretStore implements SecretStore {
  constructor(private secrets: vscode.SecretStorage) {}
  async get(k: string) { return this.secrets.get(k); }
  async set(k: string, v: string) { await this.secrets.store(k, v); }
  async delete(k: string) { await this.secrets.delete(k); }
}

let store: VsCodeSecretStore;
let settingsPanel: vscode.WebviewPanel | undefined;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let current: { agent: any; bundle: any; root: string; checkpoint?: string } | undefined;
/** Last finished run's checkpoint. Review/Undo must keep working AFTER a
 * run ends — they used to die with `current` in the run's finally block,
 * which is why "Review changes" looked dead. */
let lastRun: { root: string; checkpoint?: string } | undefined;
/** Cascade-style implicit context: the harness knows what the human is
 * looking at. Last few active editors, most recent first. */
const recentEditors: string[] = [];
function noteActiveEditor(): void {
  const f = vscode.window.activeTextEditor?.document?.uri?.fsPath;
  if (!f) return;
  const i = recentEditors.indexOf(f);
  if (i >= 0) recentEditors.splice(i, 1);
  recentEditors.unshift(f);
  if (recentEditors.length > 5) recentEditors.length = 5;
}

/** Full state for the Akosua Settings tab (keys are reported masked only). */
async function settingsState() {
  const status: Record<string, string> = {};
  for (const p of PROVIDERS) status[p.id] = maskedStatus(Boolean(await store.get(p.secretKey)));
  const cfg = vscode.workspace.getConfiguration("akosua");
  const plannerProvider = cfg.get<string>("plannerProvider", "openai");
  const plannerModel = cfg.get<string>("plannerModel", "");
  const plannerKey = Boolean(await store.get(specFor(plannerProvider === "openai" ? "openai" : "anthropic").secretKey));
  return {
    status,
    config: {
      plannerProvider, plannerModel,
      editorProvider: cfg.get<string>("editorProvider", "openai"), editorModel: cfg.get<string>("editorModel", ""),
      reviewerProvider: cfg.get<string>("reviewerProvider", "openai"), reviewerModel: cfg.get<string>("reviewerModel", ""),
      applyProvider: cfg.get<string>("applyProvider", ""), applyModel: cfg.get<string>("applyModel", ""),
      autocomplete: cfg.get<boolean>("autocomplete", false),
      personalRules: cfg.get<string>("personalRules", ""),
      mcpServersText: JSON.stringify(cfg.get("mcpServers", []), null, 2),
    },
    ready: { hasPlannerKey: plannerKey, hasPlannerModel: Boolean(plannerModel.trim()), chatReady: plannerKey && Boolean(plannerModel.trim()) },
  };
}
async function postSettingsState() {
  if (!settingsPanel) return;
  settingsPanel.webview.postMessage({ type: "state", ...(await settingsState()) });
}

async function testConnection(id: ProviderId): Promise<string> {
  const spec = specFor(id);
  const key = await store.get(spec.secretKey);
  if (!key) return `${spec.label}: no key saved yet.`;
  try {
    const res = await fetch(spec.testUrl, { headers: spec.testHeaders(key) });
    return res.ok ? `${spec.label}: connection OK ✔` : `${spec.label}: key rejected (HTTP ${res.status}). Check the key and try again.`;
  } catch (e) { return `${spec.label}: network error — ${(e as Error).message}`; }
}

async function askAndStore(id: ProviderId) {
  const spec = specFor(id);
  const value = await vscode.window.showInputBox({
    title: `Akosua — ${spec.label} API key`, password: true, ignoreFocusOut: true,
    prompt: `${spec.docsHint}. Stored in your OS credential store only — never in files or settings.`,
    placeHolder: "Paste API key (input is hidden)",
  });
  if (value) { await store.set(spec.secretKey, value.trim()); void vscode.window.showInformationMessage(`Akosua: ${spec.label} key saved.`); await postSettingsState(); }
}


/** UI-3 artifacts (DESIGN 4.6): plans/walkthroughs as files under .akosua/runs/. */
async function writeArtifact(root: string, kind: string, content: string): Promise<void> {
  try {
    const dir = path.join(root, ".akosua", "runs");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${kind}-${new Date().toISOString().replace(/[:.]/g, "-")}.md`), content, "utf8");
  } catch { /* best-effort */ }
}

/** Anything that can receive agent UI messages (today: the native chat bridge only). */
interface AgentSink { postMessage(m: unknown): void; }
async function runAgent(sink: AgentSink, userText: string) {
  let lastPhase = "understand";
  const post = (m: unknown) => {
    const x = m as Record<string, unknown>;
    if (x.type === "agentPhase") lastPhase = String(x.phase);
    if (x.type === "assistant" && lastPhase === "plan" && String(x.text ?? "").length > 200) {
      sink.postMessage({ type: "agentPlan", text: x.text });
      if (root) void writeArtifact(root, "plan", String(x.text));
      return;
    }
    sink.postMessage(m);
  };
  const cfg = vscode.workspace.getConfiguration("akosua");
  const providerId = cfg.get<string>("plannerProvider", "anthropic") as ProviderId;
  const model = cfg.get<string>("plannerModel", "");
  if (!model) { post({ type: "assistant", text: "One quick setup step: open Akosua Settings (the Settings button above) and set your Planner model ID. Akosua never guesses model names. Paste your provider key on the same page, use Test, then send again." }); return; }
  const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!root) { post({ type: "assistant", text: "Open a project folder first \u2014 Akosua's agent works on a real workspace (Understand phase needs a codebase to read)." }); return; }
  if (!core) { post({ type: "assistant", text: "Akosua core is still loading \u2014 try again in a second." }); return; }
  if (!(await store.get(specFor(providerId === "openai" ? "openai" : "anthropic").secretKey))) { post({ type: "assistant", text: `No ${providerId === "openai" ? "OpenAI" : "Claude"} API key saved yet. Open Akosua Settings (the Settings button above), paste your key, use Test, then send again. Keys are stored in your OS credential store only.` }); return; }
  if (current) { post({ type: "assistant", text: "An agent run is already in progress. Cancel it before starting another." }); return; }
  const provider = providerId === "openai" ? new core.OpenAIProvider(store) : new core.AnthropicProvider(store);
  // Model routing: Planner (primary above) + Editor (Build) + Reviewer
  // (Build->Verify gate, cross-vendor by default). A role is only routed
  // when its model id is explicitly set — Akosua never guesses model names.
  const mkProvider = (id: string) => id === "openai" ? new core.OpenAIProvider(store) : new core.AnthropicProvider(store);
  const routing: Record<string, { provider: unknown; model: string }> = {};
  const editorModel = cfg.get<string>("editorModel", ""); const reviewerModel = cfg.get<string>("reviewerModel", "");
  if (editorModel) routing.editor = { provider: mkProvider(cfg.get<string>("editorProvider", "anthropic")), model: editorModel };
  if (reviewerModel) routing.reviewer = { provider: mkProvider(cfg.get<string>("reviewerProvider", "openai")), model: reviewerModel };
  const { servers: mcpServers, errors: mcpConfigErrors } = parseMcpServers(cfg.get("mcpServers", []));
  for (const err of mcpConfigErrors) post({ type: "notice", text: `MCP config: ${err}` });
  const bundle = await core.buildAkosuaAgent({ secrets: store, provider, model, workspaceRoot: root, routing, requirePlanApproval: true,
    confirm: async (q: string) => (await vscode.window.showWarningMessage(q, { modal: true }, "Allow once")) === "Allow once",
    // Live LSP diagnostics: the editor's own language servers (TS/ESLint/
    // Dart analysis server) after a short settle delay. This is Cursor's
    // "red squiggles fed back instantly" loop, through the real IDE state.
    hostDiagnostics: async (files: string[]) => {
      await new Promise(r => setTimeout(r, 900));
      const out: string[] = [];
      for (const f of files) {
        const uri = vscode.Uri.file(path.join(root, f));
        const diags = vscode.languages.getDiagnostics(uri).filter(d => d.severity <= vscode.DiagnosticSeverity.Warning);
        for (const d of diags.slice(0, 20)) out.push(`${f}:${d.range.start.line + 1}:${d.range.start.character + 1} ${d.severity === vscode.DiagnosticSeverity.Error ? "error" : "warning"}: ${d.message} (${d.source ?? "lsp"})`);
      }
      return out.length ? `Live editor diagnostics (language servers):\n${out.join("\n")}` : "";
    },
    extraInstructions: cfg.get<string>("personalRules", ""), mcpServers });
  if (bundle.mcpConnected?.length) post({ type: "notice", text: `MCP connected: ${bundle.mcpConnected.join(", ")}` });
  for (const err of bundle.mcpErrors ?? []) post({ type: "notice", text: `MCP failed: ${err}` });
  current = { agent: bundle.agent, bundle, root };
  // Peace-of-mind checkpoint BEFORE the agent can change anything (git repos only).
  try {
    current.checkpoint = await core.createCheckpoint(root, "ui-agent-run");
    post({ type: "checkpoint", ref: current.checkpoint });
  } catch { post({ type: "notice", text: "Note: no git checkpoint (this folder is not a git repository, or git is unavailable). Changes will not be one-click undoable." }); }
  try {
    const runStartedAt = Date.now();
    const pinned = await coreBundled.resolveMentions(root, userText).catch(() => "");
    const ed = vscode.window.activeTextEditor;
    const editorCtx = ed ? `\n\n# Editor context (implicit — what the user is looking at right now):\n- Active file: ${path.relative(root, ed.document.uri.fsPath)}${ed.selection && !ed.selection.isEmpty ? `\n- Selected lines ${ed.selection.start.line + 1}-${ed.selection.end.line + 1}:\n${ed.document.getText(ed.selection).slice(0, 4000)}` : ""}${recentEditors.length ? `\n- Recently viewed: ${recentEditors.map(f => path.relative(root, f)).join(", ")}` : ""}` : "";
    if (pinned) post({ type: "notice", text: "Pinned context attached from your @mentions." });
    for await (const ev of bundle.agent.run(userText + pinned + editorCtx)) {
      if (ev.type === "phase") post({ type: "agentPhase", phase: ev.phase });
      else if (ev.type === "text") post({ type: "agentText", delta: ev.delta });
      else if (ev.type === "tool") {
        post({ type: "agentTool", name: ev.name, result: String(ev.result).slice(0, 2000), durationMs: (ev as { durationMs?: number }).durationMs, action: (ev as { action?: string }).action });
        const act = typeof (ev as { action?: string }).action === "string" ? (ev as { action: string }).action : "";
        if (ev.name === "file_editor" && act.includes(":")) {
          const verb = act.slice(0, act.indexOf(":")); const rel = act.slice(act.indexOf(":") + 1);
          if (rel && verb !== "view") void (async () => { try { const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(path.join(root, rel))); await vscode.window.showTextDocument(doc, { preview: false, preserveFocus: true }); } catch { /* mid-write: card still shows it */ } })();
        }
      }
      else if (ev.type === "review") post({ type: "agentReview", verdict: ev.verdict, text: String(ev.text).slice(0, 3000) });
      else if (ev.type === "done") { post({ type: "agentDone", phase: ev.phase, durationMs: Date.now() - runStartedAt });
        void (async () => { // change-set evidence for the native card
          try { if (current?.checkpoint && root) post({ type: "agentChangeset", files: await coreBundled.changedFilesSinceCheckpoint(root, current.checkpoint) }); } catch { /* best-effort */ }
        })();
        void (async () => { // UI-3 walkthrough artifact with change-set diff
          try { const diff = current?.checkpoint && root ? await coreBundled.diffSinceCheckpoint(root, current.checkpoint) : "";
            await writeArtifact(root ?? ".", "walkthrough", `# Akosua walkthrough\n\nTask: ${userText}\n\nFinal phase: ${ev.phase}\n\n## Change-set (vs pre-run checkpoint)\n\n${diff ? diff.slice(0, 20000) : "(no checkpoint diff available)"}\n`);
          } catch { /* best-effort */ }
        })(); }
      else if (ev.type === "cancelled") post({ type: "agentCancelled", phase: ev.phase });
      else if (ev.type === "notice") post({ type: "notice", text: ev.text });
    }
  } catch (e) { post({ type: "assistant", text: `Agent error: ${(e as Error).message}` }); }
  finally {
    const cp = current?.checkpoint; await bundle.close(); const doneRoot = root;
    lastRun = { root: doneRoot, checkpoint: cp }; current = undefined;
    if (cp) { try { post({ type: "review", diff: await core.diffSinceCheckpoint(doneRoot, cp), ref: cp }); } catch { /* diff is best-effort */ } }
  }
}

/** The ONE Akosua Settings tab (editor area). Opens/focuses a singleton
 * WebviewPanel backed by SecretStorage + akosua.* config. */
function openSettingsPanel(): void {
  if (settingsPanel) { settingsPanel.reveal(vscode.ViewColumn.One); void postSettingsState(); return; }
  const panel = vscode.window.createWebviewPanel("akosua.settings", "Akosua Settings", vscode.ViewColumn.One, { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [] });
  settingsPanel = panel;
  panel.webview.html = settingsHtml();
  panel.onDidDispose(() => { if (settingsPanel === panel) settingsPanel = undefined; });
  panel.webview.onDidReceiveMessage(async (msg: { type: string; provider?: ProviderId; value?: string; config?: Record<string, unknown> }) => {
    const post = (text: string) => panel.webview.postMessage({ type: "notice", text });
    try {
      if (msg.type === "ready") await postSettingsState();
      else if (msg.type === "setKey" && msg.provider && msg.value) { await store.set(specFor(msg.provider).secretKey, msg.value.trim()); post(`${specFor(msg.provider).label}: key saved ✔ (stored in your OS credential store)`); await postSettingsState(); }
      else if (msg.type === "clearKey" && msg.provider) { await store.delete(specFor(msg.provider).secretKey); post(`${specFor(msg.provider).label}: key cleared.`); await postSettingsState(); }
      else if (msg.type === "clearAll") { for (const p of PROVIDERS) await store.delete(p.secretKey); post("All Akosua API keys cleared."); await postSettingsState(); }
      else if (msg.type === "test" && msg.provider) post(await testConnection(msg.provider));
      else if (msg.type === "testAll") { const lines: string[] = []; for (const p of PROVIDERS) lines.push(await testConnection(p.id)); post(lines.join("\n")); }
      else if (msg.type === "openChat") await vscode.commands.executeCommand("akosua.focusChat");
      else if (msg.type === "saveConfig" && msg.config) {
        const c = msg.config; const cfg = vscode.workspace.getConfiguration("akosua");
        const put = async (k: string, v: unknown) => cfg.update(k, v, vscode.ConfigurationTarget.Global);
        for (const k of ["plannerProvider", "editorProvider", "reviewerProvider"]) { const v = String(c[k] ?? ""); if (v !== "anthropic" && v !== "openai") { post(`Settings NOT saved: ${k} must be OpenAI or Claude (Anthropic).`); return; } }
        let mcpRaw: unknown;
        try { mcpRaw = JSON.parse(String(c.mcpServersText ?? "[]")); } catch { post("Settings NOT saved: MCP servers must be valid JSON (an array). Fix the JSON and save again."); return; }
        const parsed = parseMcpServers(mcpRaw);
        if (parsed.errors.length) { post(`Settings NOT saved: ${parsed.errors.join("; ")}`); return; }
        await put("plannerProvider", c.plannerProvider); await put("plannerModel", String(c.plannerModel ?? "").trim());
        await put("editorProvider", c.editorProvider); await put("editorModel", String(c.editorModel ?? "").trim());
        await put("reviewerProvider", c.reviewerProvider); await put("reviewerModel", String(c.reviewerModel ?? "").trim());
        await put("applyProvider", String(c.applyProvider ?? "").trim()); await put("applyModel", String(c.applyModel ?? "").trim());
        await put("autocomplete", c.autocomplete === true);
        await put("personalRules", String(c.personalRules ?? ""));
        await put("mcpServers", parsed.servers);
        post("Akosua settings saved ✔"); await postSettingsState();
      }
    } catch (e) { post(`Error: ${(e as Error).message}`); }
  });
  void postSettingsState();
}

export async function activate(context: vscode.ExtensionContext) {
  store = new VsCodeSecretStore(context.secrets);
  noteActiveEditor();
  void (async () => {
    try {
      const st = await settingsState();
      if (!st.ready.chatReady) {
        const pick = await vscode.window.showInformationMessage("Akosua setup: add your API key and model ID in Akosua Settings, then press Ctrl+L to chat.", "Open Akosua Settings");
        if (pick === "Open Akosua Settings") openSettingsPanel();
      }
    } catch { /* guidance is best-effort */ }
  })();
  context.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor(() => noteActiveEditor()),
    vscode.commands.registerCommand("akosua.openSettings", () => openSettingsPanel()),
    vscode.commands.registerCommand("akosua.openPanel", () => vscode.commands.executeCommand("akosua.focusChat")),
    // Native UI bridge (DESIGN UI-2): the fork's built-in chat view sends
    // akosua.agent.send and receives the SAME agent events via
    // akosua.native.event. The native panel is the ONLY chat UI (the legacy
    // extension webview was retired once the native UI landed).
    vscode.commands.registerCommand("akosua.agent.send", async (arg: { text?: string }) => {
      const text = String(arg?.text ?? "").trim();
      if (!text) return;
      await Promise.resolve(vscode.commands.executeCommand("akosua.focusChat")).catch(() => undefined);
      // Translate webview message shapes to native AgentEvent shapes.
      const toNative = (m: unknown) => {
        const x = m as Record<string, unknown>;
        switch (x.type) {
          case "agentPhase": return { type: "phase", phase: x.phase };
          case "agentText": return { type: "text", delta: x.delta };
          case "agentTool": return { type: "tool", name: x.name, result: x.result, durationMs: x.durationMs, action: x.action };
          case "agentReview": return { type: "review", verdict: x.verdict, text: x.text };
          case "agentDone": return { type: "done", phase: x.phase, durationMs: x.durationMs };
          case "agentChangeset": return { type: "changeset", files: x.files };
          case "agentCancelled": return { type: "cancelled", phase: x.phase };
          case "checkpoint": return { type: "notice", text: `Checkpoint saved: ${x.ref} (Undo available)` };
          case "review": return { type: "notice", text: `Changes since checkpoint:\n${x.diff}` };
          case "agentPlan": return { type: "plan", text: x.text };
          default: return x; // notice / assistant pass through (view renders .text)
        }
      };
      const sink: AgentSink = {
        postMessage: (m: unknown) => { void Promise.resolve(vscode.commands.executeCommand("akosua.native.event", toNative(m))).catch(() => undefined); },
      };
      await runAgent(sink, text);
    }),
    vscode.commands.registerCommand("akosua.agent.cancel", () => { current?.agent?.cancel?.(); }),
    // Change-set review (UI-3/C1): native diff (checkpoint version vs current)
    // + inline add decorations in the editor.
    vscode.commands.registerCommand("akosua.agent.openChangeDiff", async () => {
      const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      const ref = current?.checkpoint ?? lastRun?.checkpoint;
      if (!root || !ref) { void vscode.window.showInformationMessage("Akosua: no checkpoint change-set yet — run the agent first."); return; }
      const files = await coreBundled.changedFilesSinceCheckpoint(root, ref);
      if (!files.length) { void vscode.window.showInformationMessage("Akosua: no changes since the checkpoint."); return; }
      const pick = await vscode.window.showQuickPick<{ label: string; description: string }>(files.map((f: { path: string; status: string }) => ({ label: f.path, description: f.status })), { placeHolder: "Open native diff for…" });
      if (!pick) return;
      const patch = await coreBundled.fileDiffSinceCheckpoint(root, ref, pick.label);
      if (!patch.trim()) { void vscode.window.showInformationMessage(`Akosua: ${pick.label} is new/untracked — no base diff.`); return; }
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "akosua-diff-"));
      // Reconstruct the checkpoint version from the patch's removed lines is
      // lossy; use git show instead for exactness.
      const { execFileSync } = await import("node:child_process");
      let base = "";
      try { base = execFileSync("git", ["show", `${ref}:${pick.label}`], { cwd: root, encoding: "utf8" }); } catch { base = ""; }
      const baseFile = path.join(tmp, "base" + path.extname(pick.label));
      fs.writeFileSync(baseFile, base);
      await vscode.commands.executeCommand("vscode.diff", vscode.Uri.file(baseFile), vscode.Uri.file(path.join(root, pick.label)), `Akosua change: ${pick.label} (checkpoint → current)`);
    }),
    vscode.commands.registerCommand("akosua.agent.toggleInlineDiff", async () => {
      const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      const ref = current?.checkpoint ?? lastRun?.checkpoint;
      const editor = vscode.window.activeTextEditor;
      if (!root || !ref || !editor) return;
      const rel = path.relative(root, editor.document.uri.fsPath);
      const patch = await coreBundled.fileDiffSinceCheckpoint(root, ref, rel);
      const [fd] = coreBundled.parseUnifiedDiff(patch);
      const adds: vscode.Range[] = [];
      for (const h of fd?.hunks ?? []) for (const l of h.lines) if (l.type === "add" && l.newLine) adds.push(new vscode.Range(l.newLine - 1, 0, l.newLine - 1, 0));
      if ((editor as unknown as { __akosuaDiffOn?: boolean }).__akosuaDiffOn) {
        editor.setDecorations(addDecoration, []); (editor as unknown as { __akosuaDiffOn?: boolean }).__akosuaDiffOn = false;
      } else {
        editor.setDecorations(addDecoration, adds); (editor as unknown as { __akosuaDiffOn?: boolean }).__akosuaDiffOn = true;
      }
    }),
    vscode.commands.registerCommand("akosua.agent.undoChanges", async () => {
      const root = lastRun?.root ?? current?.root ?? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      const ref = current?.checkpoint ?? lastRun?.checkpoint;
      if (!root || !ref) { void vscode.window.showInformationMessage("Akosua: nothing to undo — no checkpoint from a previous run yet."); return; }
      const pick = await vscode.window.showWarningMessage("Undo ALL changes since the pre-run checkpoint? Files created by the run will be removed.", { modal: true }, "Undo changes");
      if (pick !== "Undo changes") return;
      try {
        const msg = await coreBundled.restoreCheckpoint(root, ref);
        void vscode.window.showInformationMessage(`Akosua: ${msg}.`);
      } catch (e) { void vscode.window.showErrorMessage(`Akosua undo failed: ${(e as Error).message}`); }
    }),
    // Inline edit (C1): select code -> describe change -> editor-role model
    // rewrites exactly that range. Applies immediately; undo is one Ctrl+Z and
    // the checkpoint/Keep-Undo flow still covers agent runs.
    vscode.commands.registerCommand("akosua.inlineEdit", async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) return;
      const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? "";
      const cfg = vscode.workspace.getConfiguration("akosua");
      const instruction = await vscode.window.showInputBox({ prompt: "Akosua inline edit — describe the change", placeHolder: "e.g. convert to async/await, add null guard, rename for clarity" });
      if (!instruction) return;
      const doc = editor.document; const sel = editor.selection;
      const from = Math.max(0, sel.start.line - 30), to = Math.min(doc.lineCount - 1, sel.end.line + 30);
      const prefix = doc.getText(new vscode.Range(0, 0, sel.start.line, sel.start.character)).split("\n").slice(-30).join("\n");
      const suffix = doc.getText(new vscode.Range(sel.end.line, sel.end.character, doc.lineCount, 0)).split("\n").slice(0, 30).join("\n");
      try {
        const providerId = cfg.get<string>("editorProvider", "") || cfg.get<string>("plannerProvider", "anthropic");
        const model = cfg.get<string>("editorModel", "") || cfg.get<string>("plannerModel", "");
        if (!model) { void vscode.window.showWarningMessage("Akosua: set an Editor (or Planner) model in Settings → Akosua first — model names are never guessed."); return; }
        const provider = providerId === "openai" ? new coreBundled.OpenAIProvider(store) : new coreBundled.AnthropicProvider(store);
        const result = await coreBundled.inlineEdit(provider, model, {
          filePath: root ? path.relative(root, doc.uri.fsPath) : doc.uri.fsPath,
          language: doc.languageId, selection: doc.getText(sel), prefix, suffix, instruction,
        });
        await editor.edit(b => b.replace(sel, result.replacement));
        void vscode.window.showInformationMessage(`Akosua inline edit applied. ${result.explanation}`);
      } catch (e) { void vscode.window.showErrorMessage(`Akosua inline edit failed: ${(e as Error).message}`); }
    }),
    vscode.commands.registerCommand("akosua.testConnections", async () => {
      const lines: string[] = [];
      for (const p of PROVIDERS) lines.push(await testConnection(p.id));
      void vscode.window.showInformationMessage("Akosua connection test", { modal: true, detail: lines.join("\n") });
    }),
    vscode.commands.registerCommand("akosua.agent.brainRefresh", async () => {
      const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      if (!root) { void vscode.window.showWarningMessage("Akosua: open a project folder first (File > Open Folder), then Rebuild the Project Brain."); return; }
      // Feedback while rebuilding: a visible progress notification AND
      // a loading/restored state pushed into the Brain view itself, so
      // clicking Rebuild never looks like nothing happened.
      const emit = (payload: unknown) => Promise.resolve(vscode.commands.executeCommand("akosua.native.brain", payload)).catch(() => undefined);
      try {
        await emit({ type: "brainLoading", message: "Rebuilding Project Brain…" });
        await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: "Akosua: rebuilding Project Brain…", cancellable: false }, async () => {
          const fp = await coreBundled.fingerprintProject(root);
          const idx = await coreBundled.indexProject(root);
          const packs = coreBundled.detectStackPacks(fp).map((p: { name: string }) => p.name);
          await emit({
            type: "brainDone",
            fingerprintMarkdown: coreBundled.renderProjectBrain(fp),
            contractMapMarkdown: coreBundled.renderBrainV2(fp, idx),
            packIds: packs,
          });
        });
      } catch (err) {
        await emit({ type: "brainError", text: (err as Error).message });
        void vscode.window.showErrorMessage(`Akosua: Project Brain rebuild failed — ${(err as Error).message}`);
      }
    }),
    ...PROVIDERS.map(p => vscode.commands.registerCommand(p.settingsCommand, () => askAndStore(p.id))),
    vscode.commands.registerCommand("akosua.clearKeys", async () => {
      for (const p of PROVIDERS) await store.delete(p.secretKey);
      void vscode.window.showInformationMessage("Akosua: all API keys cleared."); await postSettingsState();
    }),
  );
}
export function deactivate() { settingsPanel = undefined; }
