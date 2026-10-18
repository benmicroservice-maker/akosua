import * as vscode from "vscode";
// @akosua/core is bundled INTO this extension at build time by esbuild
// (see esbuild.mts): VS Code's product packager cannot resolve a runtime
// dependency that lives outside extensions/, so the core travels inside
// dist/extension.js. The module is declared in core-shim.d.ts (untyped here
// by design — the core's own test suite owns its correctness).
import * as coreBundled from "@akosua/core";
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

async function runAgent(view_: vscode.WebviewView, userText: string) {
  const post = (m: unknown) => void view_.webview.postMessage(m);
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
    for await (const ev of bundle.agent.run(userText)) {
      if (ev.type === "phase") post({ type: "agentPhase", phase: ev.phase });
      else if (ev.type === "text") post({ type: "agentText", delta: ev.delta });
      else if (ev.type === "tool") post({ type: "agentTool", name: ev.name, result: String(ev.result).slice(0, 2000) });
      else if (ev.type === "review") post({ type: "agentReview", verdict: ev.verdict, text: String(ev.text).slice(0, 3000) });
      else if (ev.type === "done") post({ type: "agentDone", phase: ev.phase });
      else if (ev.type === "cancelled") post({ type: "agentCancelled", phase: ev.phase });
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
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider("akosua.chat", new AkosuaView()),
    vscode.commands.registerCommand("akosua.openPanel", () => vscode.commands.executeCommand("akosua.chat.focus")),
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
