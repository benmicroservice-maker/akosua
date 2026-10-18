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
interface ChatMessage { role: string; content: string; }
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type CoreModule = any;
const core: CoreModule = coreBundled;
import { PROVIDERS, specFor, maskedStatus, parseMcpServers, type ProviderId } from "./config.js";

/** Bridges VS Code SecretStorage (Windows Credential Manager on Windows)
 * to the core SecretStore interface. This is the ONLY place keys live. */
class VsCodeSecretStore implements SecretStore {
  constructor(private secrets: vscode.SecretStorage) {}
  async get(k: string) { return this.secrets.get(k); }
  async set(k: string, v: string) { await this.secrets.store(k, v); }
  async delete(k: string) { await this.secrets.delete(k); }
}

let store: VsCodeSecretStore;
let view: vscode.WebviewView | undefined;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let current: { agent: any; bundle: any; root: string; checkpoint?: string } | undefined;
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

async function refreshStatus() {
  if (!view) return;
  const status: Record<string, string> = {};
  for (const p of PROVIDERS) status[p.id] = maskedStatus(Boolean(await store.get(p.secretKey)));
  void view.webview.postMessage({ type: "status", status });
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
  if (value) { await store.set(spec.secretKey, value.trim()); void vscode.window.showInformationMessage(`Akosua: ${spec.label} key saved.`); await refreshStatus(); }
}


/** UI-3 artifacts (DESIGN 4.6): plans/walkthroughs as files under .akosua/runs/. */
async function writeArtifact(root: string, kind: string, content: string): Promise<void> {
  try {
    const dir = path.join(root, ".akosua", "runs");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${kind}-${new Date().toISOString().replace(/[:.]/g, "-")}.md`), content, "utf8");
  } catch { /* best-effort */ }
}

async function runAgent(view_: vscode.WebviewView, userText: string) {
  let lastPhase = "understand";
  const post = (m: unknown) => {
    const x = m as Record<string, unknown>;
    if (x.type === "agentPhase") lastPhase = String(x.phase);
    if (x.type === "assistant" && lastPhase === "plan" && String(x.text ?? "").length > 200) {
      void view_.webview.postMessage({ type: "agentPlan", text: x.text });
      if (root) void writeArtifact(root, "plan", String(x.text));
      return;
    }
    void view_.webview.postMessage(m);
  };
  const cfg = vscode.workspace.getConfiguration("akosua");
  const providerId = cfg.get<string>("plannerProvider", "anthropic") as ProviderId;
  const model = cfg.get<string>("plannerModel", "");
  if (!model) { post({ type: "assistant", text: "Set a planner model id first: Settings \u2192 Akosua \u2192 Planner Model. Akosua never guesses model names. Then make sure the provider key is saved in Providers & Keys." }); return; }
  const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!root) { post({ type: "assistant", text: "Open a project folder first \u2014 Akosua's agent works on a real workspace (Understand phase needs a codebase to read)." }); return; }
  if (!core) { post({ type: "assistant", text: "Akosua core is still loading \u2014 try again in a second." }); return; }
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
  const bundle = await core.buildAkosuaAgent({ secrets: store, provider, model, workspaceRoot: root, routing,
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
    const pinned = await coreBundled.resolveMentions(root, userText).catch(() => "");
    const ed = vscode.window.activeTextEditor;
    const editorCtx = ed ? `\n\n# Editor context (implicit — what the user is looking at right now):\n- Active file: ${path.relative(root, ed.document.uri.fsPath)}${ed.selection && !ed.selection.isEmpty ? `\n- Selected lines ${ed.selection.start.line + 1}-${ed.selection.end.line + 1}:\n${ed.document.getText(ed.selection).slice(0, 4000)}` : ""}${recentEditors.length ? `\n- Recently viewed: ${recentEditors.map(f => path.relative(root, f)).join(", ")}` : ""}` : "";
    if (pinned) post({ type: "notice", text: "Pinned context attached from your @mentions." });
    for await (const ev of bundle.agent.run(userText + pinned + editorCtx)) {
      if (ev.type === "phase") post({ type: "agentPhase", phase: ev.phase });
      else if (ev.type === "text") post({ type: "agentText", delta: ev.delta });
      else if (ev.type === "tool") post({ type: "agentTool", name: ev.name, result: String(ev.result).slice(0, 2000) });
      else if (ev.type === "review") post({ type: "agentReview", verdict: ev.verdict, text: String(ev.text).slice(0, 3000) });
      else if (ev.type === "done") { post({ type: "agentDone", phase: ev.phase });
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
    const cp = current?.checkpoint; await bundle.close(); const doneRoot = root; current = undefined;
    if (cp) { try { post({ type: "review", diff: await core.diffSinceCheckpoint(doneRoot, cp), ref: cp }); } catch { /* diff is best-effort */ } }
  }
}

async function undoLastRun(view_: vscode.WebviewView, ref: string) {
  const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!root || !core) return;
  try { const msg = await core.restoreCheckpoint(root, ref); void view_.webview.postMessage({ type: "notice", text: `Undo complete: ${msg}. Review your files, then run the agent again when ready.` }); }
  catch (e) { void view_.webview.postMessage({ type: "notice", text: `Undo failed: ${(e as Error).message}` }); }
}

class AkosuaView implements vscode.WebviewViewProvider {
  resolveWebviewView(v: vscode.WebviewView) {
    view = v;
    v.webview.options = { enableScripts: true, localResourceRoots: [] };
    v.webview.html = html();
    v.webview.onDidReceiveMessage(async (msg: { type: string; provider?: ProviderId; value?: string; text?: string }) => {
      try {
        if (msg.type === "ready") await refreshStatus();
        else if (msg.type === "setKey" && msg.provider && msg.value) { await store.set(specFor(msg.provider).secretKey, msg.value.trim()); await refreshStatus(); void v.webview.postMessage({ type: "notice", text: `${specFor(msg.provider).label}: key saved ✔` }); }
        else if (msg.type === "clearKey" && msg.provider) { await store.delete(specFor(msg.provider).secretKey); await refreshStatus(); }
        else if (msg.type === "test" && msg.provider) void v.webview.postMessage({ type: "notice", text: await testConnection(msg.provider) });
        else if (msg.type === "chat" && msg.text) void runAgent(v, msg.text);
        else if (msg.type === "cancel") { current?.agent?.cancel(); }
        else if (msg.type === "undo" && msg.text) void undoLastRun(v, msg.text);
      } catch (e) { void v.webview.postMessage({ type: "notice", text: `Error: ${(e as Error).message}` }); }
    });
  }
}

export async function activate(context: vscode.ExtensionContext) {
  store = new VsCodeSecretStore(context.secrets);
  noteActiveEditor();
  context.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor(() => noteActiveEditor()),
    vscode.window.registerWebviewViewProvider("akosua.chat", new AkosuaView()),
    vscode.commands.registerCommand("akosua.openPanel", () => vscode.commands.executeCommand("akosua.chat.focus")),
    // Native UI bridge (DESIGN UI-2): the fork's built-in chat view sends
    // akosua.agent.send and receives the SAME agent events via
    // akosua.native.event. The webview remains as fallback during migration.
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
          case "agentTool": return { type: "tool", name: x.name, result: x.result };
          case "agentReview": return { type: "review", verdict: x.verdict, text: x.text };
          case "agentDone": return { type: "done", phase: x.phase };
          case "agentChangeset": return { type: "changeset", files: x.files };
          case "agentCancelled": return { type: "cancelled", phase: x.phase };
          case "checkpoint": return { type: "notice", text: `Checkpoint saved: ${x.ref} (Undo available)` };
          case "review": return { type: "notice", text: `Changes since checkpoint:\n${x.diff}` };
          case "agentPlan": return { type: "plan", text: x.text };
          default: return x; // notice / assistant pass through (view renders .text)
        }
      };
      const sink = {
        webview: { postMessage: (m: unknown) => { void Promise.resolve(vscode.commands.executeCommand("akosua.native.event", toNative(m))).catch(() => undefined); } },
      } as unknown as vscode.WebviewView;
      await runAgent(sink, text);
    }),
    vscode.commands.registerCommand("akosua.agent.cancel", () => { current?.agent?.cancel?.(); }),
    // Change-set review (UI-3/C1): native diff (checkpoint version vs current)
    // + inline add decorations in the editor.
    vscode.commands.registerCommand("akosua.agent.openChangeDiff", async () => {
      const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      const ref = current?.checkpoint;
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
      const ref = current?.checkpoint;
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
    vscode.commands.registerCommand("akosua.agent.brainRefresh", async () => {
      const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      if (!root) return;
      try {
        const fp = await coreBundled.fingerprintProject(root);
        const idx = await coreBundled.indexProject(root);
        const packs = coreBundled.detectStackPacks(fp).map((p: { name: string }) => p.name);
        await Promise.resolve(vscode.commands.executeCommand("akosua.native.brain", {
          fingerprintMarkdown: coreBundled.renderProjectBrain(fp),
          contractMapMarkdown: coreBundled.renderBrainV2(fp, idx),
          packIds: packs,
        })).catch(() => undefined);
      } catch { /* brain is best-effort until the native view exists */ }
    }),
    ...PROVIDERS.map(p => vscode.commands.registerCommand(p.settingsCommand, () => askAndStore(p.id))),
    vscode.commands.registerCommand("akosua.clearKeys", async () => {
      for (const p of PROVIDERS) await store.delete(p.secretKey);
      void vscode.window.showInformationMessage("Akosua: all API keys cleared."); await refreshStatus();
    }),
  );
}
export function deactivate() { view = undefined; }

function html(): string {
  const rows = PROVIDERS.map(p => `
    <section class="card">
      <div class="row"><strong>${p.label}</strong><span id="st-${p.id}" class="status">…</span></div>
      <p class="hint">${p.docsHint}</p>
      <div class="row">
        <input id="key-${p.id}" type="password" placeholder="Paste API key" autocomplete="off" />
        <button data-save="${p.id}">Save</button>
        <button data-test="${p.id}" class="secondary">Test</button>
        <button data-clear="${p.id}" class="secondary">Clear</button>
      </div>
    </section>`).join("");
  return `<!DOCTYPE html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline';">
<style>
 body{font-family:var(--vscode-font-family);color:var(--vscode-foreground);padding:10px}
 .tabs{display:flex;gap:6px;margin-bottom:10px} button{background:var(--vscode-button-background);color:var(--vscode-button-foreground);border:0;padding:5px 10px;border-radius:4px;cursor:pointer}
 button.secondary{background:var(--vscode-button-secondaryBackground);color:var(--vscode-button-secondaryForeground)}
 .card{border:1px solid var(--vscode-panel-border);border-radius:6px;padding:8px;margin:8px 0}
 .row{display:flex;gap:6px;align-items:center} .hint{opacity:.75;font-size:12px}
 input{flex:1;background:var(--vscode-input-background);color:var(--vscode-input-foreground);border:1px solid var(--vscode-input-border);padding:5px;border-radius:4px}
 .status{margin-left:auto;font-size:12px;opacity:.85} .msg{white-space:pre-wrap;margin:6px 0}
 textarea{width:100%;box-sizing:border-box;background:var(--vscode-input-background);color:var(--vscode-input-foreground);border:1px solid var(--vscode-input-border);border-radius:4px}
 .hidden{display:none}
</style></head><body>
 <div class="tabs"><button id="tabKeys">Providers &amp; Keys</button><button id="tabChat" class="secondary">Chat</button></div>
 <div id="notice" class="msg"></div>
 <div id="panelKeys">
   <p class="hint">Keys live in your OS credential store (Windows Credential Manager). Never in files, settings, or git. They are revoked/rotated by you at any time.</p>
   ${rows}
   <p class="hint">Model per phase: VS Code Settings → “Akosua” (Planner / Editor / Reviewer). Default: Claude plans+edits, OpenAI cross-reviews.</p>
 </div>
 <div id="panelChat" class="hidden">
   <div id="phases" class="row" style="flex-wrap:wrap;font-size:11px;margin-bottom:6px">
     <span data-phase="understand">1 Understand</span><span>→</span><span data-phase="research">2 Research</span><span>→</span><span data-phase="plan">3 Plan</span><span>→</span><span data-phase="build">4 Build</span><span>→</span><span data-phase="verify">5 Verify</span>
   </div>
   <div id="log"></div>
   <textarea id="chatInput" rows="4" placeholder="Ask Akosua… (agent workflow Understand→Research→Plan→Build→Verify arrives in the next integration step)"></textarea>
   <div class="row"><button id="send">Send</button><button id="cancelRun" class="secondary">Cancel run</button><button id="undoRun" class="secondary hidden">Undo last agent changes</button></div>
   <div id="reviewBox" class="msg"></div>
 </div>
<script>
 const vscode = acquireVsCodeApi();
 const $ = id => document.getElementById(id);
 $('tabKeys').onclick = () => { $('panelKeys').classList.remove('hidden'); $('panelChat').classList.add('hidden'); };
 $('tabChat').onclick = () => { $('panelChat').classList.remove('hidden'); $('panelKeys').classList.add('hidden'); };
 document.querySelectorAll('[data-save]').forEach(b => b.onclick = () => { const id=b.dataset.save; const v=$('key-'+id).value; if(v) { vscode.postMessage({type:'setKey',provider:id,value:v}); $('key-'+id).value=''; } });
 document.querySelectorAll('[data-test]').forEach(b => b.onclick = () => vscode.postMessage({type:'test',provider:b.dataset.test}));
 document.querySelectorAll('[data-clear]').forEach(b => b.onclick = () => vscode.postMessage({type:'clearKey',provider:b.dataset.clear}));
 $('cancelRun').onclick = () => vscode.postMessage({type:'cancel'});
 $('undoRun').onclick = () => { if(window._checkpoint) vscode.postMessage({type:'undo', text: window._checkpoint}); };
 $('send').onclick = () => { const t=$('chatInput').value.trim(); if(!t) return; $('log').innerHTML += '<div class="msg"><b>You:</b> '+t.replace(/</g,'&lt;')+'</div>'; $('chatInput').value=''; vscode.postMessage({type:'chat',text:t}); };
 window.addEventListener('message', e => { const m=e.data;
   if(m.type==='status') for(const [id,s] of Object.entries(m.status)) { const el=$('st-'+id); if(el) el.textContent=s; }
   if(m.type==='notice') $('notice').textContent=m.text;
   if(m.type==='assistant') $('log').innerHTML += '<div class="msg"><b>Akosua:</b> '+String(m.text).replace(/</g,'&lt;')+'</div>';
   if(m.type==='agentPhase') { document.querySelectorAll('[data-phase]').forEach(s=>s.style.fontWeight='normal'); const el=document.querySelector('[data-phase="'+m.phase+'"]'); if(el){el.style.fontWeight='bold'; el.style.textDecoration='underline';} $('log').innerHTML += '<div class="msg">— Phase: <b>'+m.phase+'</b> —</div>'; window._cur=document.createElement('div'); window._cur.className='msg'; $('log').appendChild(window._cur); }
   if(m.type==='agentText' && window._cur) window._cur.textContent += m.delta;
   if(m.type==='agentTool') $('log').innerHTML += '<div class="msg">🔧 <b>'+m.name+'</b><pre style="white-space:pre-wrap;opacity:.8">'+String(m.result).replace(/</g,'&lt;')+'</pre></div>';
   if(m.type==='agentReview') $('log').innerHTML += '<div class="msg">🧐 <b>Cross-model review: '+m.verdict+'</b><pre style="white-space:pre-wrap;opacity:.85">'+String(m.text).replace(/</g,'&lt;')+'</pre></div>';
   if(m.type==='agentDone') $('log').innerHTML += '<div class="msg">✔ Agent finished (phase: '+m.phase+')</div>';
   if(m.type==='agentCancelled') $('log').innerHTML += '<div class="msg">■ Run cancelled by you (phase: '+m.phase+'). Any checkpoint below still lets you undo partial changes.</div>';
   if(m.type==='checkpoint') { window._checkpoint = m.ref; $('reviewBox').textContent = 'Checkpoint saved: '+m.ref; }
   if(m.type==='review') { window._checkpoint = m.ref; $('reviewBox').innerHTML = '<b>Changes since checkpoint:</b><pre style="white-space:pre-wrap">'+String(m.diff).replace(/</g,'&lt;')+'</pre>'; $('undoRun').classList.remove('hidden'); }
 });
 vscode.postMessage({type:'ready'});
</script></body></html>`;
}
