import { PROVIDERS } from "./config.js";

/**
 * The ONE Akosua Settings tab (Cursor/Antigravity-style): a single editor-area
 * page with every Akosua setting — provider keys (SecretStorage-backed, never
 * values in the page), connection tests, model routing, fast-apply,
 * autocomplete, MCP servers and personal rules. No Command Palette hunting,
 * no settings.json editing for normal use.
 */
export function settingsHtml(): string {
  const rows = PROVIDERS.map(p => `
    <section class="card">
      <div class="row"><strong>${p.label}</strong><span id="st-${p.id}" class="status">…</span></div>
      <p class="hint">${p.docsHint}</p>
      <div class="row">
        <input id="key-${p.id}" type="password" placeholder="Paste API key" autocomplete="off" />
        <button data-save="${p.id}">Save key</button>
        <button data-test="${p.id}" class="secondary">Test</button>
        <button data-clear="${p.id}" class="secondary">Clear</button>
      </div>
    </section>`).join("");
  const role = (id: string, label: string, hint: string) => `
    <div class="role">
      <label>${label}</label>
      <div class="row">
        <select id="cfg-${id}Provider">
          <option value="openai">OpenAI</option>
          <option value="anthropic">Claude (Anthropic)</option>
        </select>
        <input id="cfg-${id}Model" type="text" placeholder="Exact model ID (e.g. from your provider)" autocomplete="off" />
      </div>
      <p class="hint">${hint}</p>
    </div>`;
  return `<!DOCTYPE html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline';">
<style>
 body{font-family:var(--vscode-font-family);color:var(--vscode-foreground);padding:0;margin:0;background:var(--vscode-editor-background)}
 .layout{display:flex;min-height:100vh}
 .rail{width:52px;flex:0 0 52px;border-right:1px solid var(--vscode-panel-border);padding:14px 0;display:flex;flex-direction:column;align-items:center;gap:6px}
 .rail a{display:flex;align-items:center;justify-content:center;width:34px;height:34px;border-radius:8px;color:var(--vscode-foreground);text-decoration:none;font-size:16px;opacity:.75}
 .rail a:hover{background:var(--vscode-list-hoverBackground);opacity:1}
 .main{flex:1;padding:26px 30px;max-width:820px}
 h1{font-size:20px;font-weight:600;margin:0 0 4px}
 h2{font-size:13px;font-weight:600;text-transform:uppercase;letter-spacing:.06em;opacity:.85;margin:30px 0 10px}
 /* Motion system (same language as the native panels, MOTION.md):
    press 120ms spring squash, state 180ms expo-out, entrances 240ms.
    Transform/opacity only; reduced motion collapses to fades. */
 button{background:var(--vscode-button-background);color:var(--vscode-button-foreground);border:0;padding:6px 12px;border-radius:6px;cursor:pointer;white-space:nowrap;font-size:12px;transition:background-color 180ms cubic-bezier(.16,1,.3,1),transform 120ms cubic-bezier(.34,1.56,.64,1),opacity 180ms ease}
 button.secondary{background:var(--vscode-button-secondaryBackground);color:var(--vscode-button-secondaryForeground)}
 button:hover{background:var(--vscode-button-hoverBackground)}
 button:active{transform:scale(.96)}
 button:disabled{opacity:.55;cursor:default;transform:none}
 button.busy{opacity:.65;pointer-events:none}
 button.saved{animation:akosua-pop 260ms cubic-bezier(.34,1.56,.64,1)}
 @keyframes akosua-pop{0%{transform:scale(.92)}60%{transform:scale(1.05)}100%{transform:scale(1)}}
 @keyframes akosua-in{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:translateY(0)}}
 .card{border:1px solid var(--vscode-panel-border);border-radius:10px;padding:12px 14px;margin:10px 0;background:var(--vscode-editorWidget-background);animation:akosua-in 240ms cubic-bezier(.16,1,.3,1) both;transition:border-color 180ms ease}
 .card:hover{border-color:var(--vscode-focusBorder)}
 .card.flash-ok{animation:akosua-flash-ok 900ms ease-out both}
 @keyframes akosua-flash-ok{0%{border-color:var(--vscode-testing-iconPassed)}100%{border-color:var(--vscode-panel-border)}}
 input[type=text],input[type=password],select,textarea{transition:border-color 180ms ease,box-shadow 180ms ease}
 input[type=text]:focus,input[type=password]:focus,select:focus,textarea:focus{border-color:var(--vscode-focusBorder);box-shadow:0 0 0 1px var(--vscode-focusBorder);outline:none}
 .status.pop{animation:akosua-pop 260ms cubic-bezier(.34,1.56,.64,1)}
 .rail a{transition:background-color 180ms ease,transform 120ms cubic-bezier(.34,1.56,.64,1),opacity 180ms ease}
 .rail a:active{transform:scale(.9)}
 #notice{animation:akosua-in 240ms cubic-bezier(.16,1,.3,1) both}
 #ready{animation:akosua-in 240ms cubic-bezier(.16,1,.3,1) both}
 @media (prefers-reduced-motion: reduce){*,*::before,*::after{animation-duration:.01ms!important;transition-duration:.01ms!important}}
 .row{display:flex;gap:8px;align-items:center;margin:6px 0}
 .hint{opacity:.7;font-size:12px;margin:4px 0;line-height:1.5}
 input[type=text],input[type=password],select,textarea{flex:1;background:var(--vscode-input-background);color:var(--vscode-input-foreground);border:1px solid var(--vscode-input-border);padding:7px 8px;border-radius:6px;font-family:inherit;font-size:12px}
 textarea{width:100%;box-sizing:border-box}
 .status{margin-left:auto;font-size:12px;opacity:.9}
 #notice{white-space:pre-wrap;margin:10px 0;padding:8px 10px;border-radius:8px;background:var(--vscode-textBlockQuote-background);display:none;font-size:12px}
 #ready{padding:12px 14px;border-radius:10px;margin:14px 0;border:1px solid var(--vscode-panel-border);font-size:12px;line-height:1.6}
 .ok{color:var(--vscode-testing-iconPassed)} .missing{opacity:.8}
 label{font-weight:600;font-size:13px}
 .role{margin:12px 0}
</style></head><body><div class="layout"><nav class="rail"><a href="#providers" title="Providers &amp; API keys">🔑</a><a href="#models" title="Models">✨</a><a href="#advanced" title="Inline edit, MCP &amp; rules">⚙️</a></nav><div class="main">
 <h1>Akosua Settings</h1>
 <p class="hint">Everything Akosua needs, on one page. Flow: paste a key → Test → set your model IDs → open chat (Ctrl+L) and send.</p>
 <div id="ready">Checking setup…</div>
 <div id="notice"></div>

 <h2 id="providers">Providers &amp; API keys</h2>
 <p class="hint">Keys live in your OS credential store (Windows Credential Manager). Never in files, settings, or git.</p>
 ${rows}
 <div class="row"><button id="testAll">Test all connections</button><button id="clearAll" class="secondary">Clear all keys</button></div>

 <h2 id="models">Models</h2>
 <p class="hint">Akosua never guesses model names — use the exact IDs from your provider. Only the Planner route is required to chat; Editor/Reviewer blank = Planner route is used.</p>
 ${role("planner", "Planner", "Plans and drives the run. Use your strongest model.")}
 ${role("editor", "Editor", "Makes code edits in the Build phase. Fast + strong works well.")}
 ${role("reviewer", "Reviewer", "Cross-checks the work before Verify. A different provider is a good cross-check.")}

 <h2 id="advanced">Inline edit &amp; autocomplete</h2>
 <div class="role"><label>Fast-apply (inline edits)</label>
   <div class="row">
     <input id="cfg-applyProvider" type="text" placeholder="Provider: openai or anthropic (blank = Editor route)" autocomplete="off" />
     <input id="cfg-applyModel" type="text" placeholder="Apply model ID (blank = Editor model)" autocomplete="off" />
   </div>
 </div>
 <div class="row"><input id="cfg-autocomplete" type="checkbox" style="flex:0" /><label for="cfg-autocomplete" style="font-weight:400">Ghost-text autocomplete (spends API calls as you type)</label></div>

 <h2>MCP servers</h2>
 <p class="hint">External MCP servers as JSON (stdio). Example: [{"name":"github","command":"npx","args":["-y","@modelcontextprotocol/server-github"]}]. Tools stay out of the Build phase unless a server sets "allowBuild": true.</p>
 <textarea id="cfg-mcpServersText" rows="6" spellcheck="false"></textarea>

 <h2>Personal rules</h2>
 <p class="hint">Standing instructions the agent always follows (all projects). Project-level AKOSUA_RULES.md adds on top.</p>
 <textarea id="cfg-personalRules" rows="5" placeholder="e.g. Always run the test suite before declaring done. Prefer Prisma over raw SQL."></textarea>

 <div class="row" style="margin-top:16px"><button id="saveConfig">Save model &amp; advanced settings</button><button id="openChat" class="secondary">Open Akosua chat (Ctrl+L)</button></div>
<script>
 const vscode = acquireVsCodeApi();
 const $ = id => document.getElementById(id);
 let populated = false;
 const notice = t => { const n=$('notice'); n.style.display='block'; n.textContent=t; n.style.animation='none'; void n.offsetWidth; n.style.animation=''; };
 const busy = (b, on, label) => { if(!b) return; b.classList.toggle('busy', on); if(label){ if(on){ b.dataset.label=b.textContent; b.textContent=label; } else if(b.dataset.label){ b.textContent=b.dataset.label; } } };
 const savedPop = b => { if(!b) return; b.classList.remove('saved'); void b.offsetWidth; b.classList.add('saved'); const card=b.closest('.card'); if(card){ card.classList.remove('flash-ok'); void card.offsetWidth; card.classList.add('flash-ok'); } };
 document.querySelectorAll('[data-save]').forEach(b => b.onclick = () => { const id=b.dataset.save; const v=$('key-'+id).value.trim(); if(!v){notice('Paste a key first, then Save.');return;} busy(b,true,'Saving\u2026'); setTimeout(()=>{busy(b,false); savedPop(b);},450); vscode.postMessage({type:'setKey',provider:id,value:v}); $('key-'+id).value=''; });
 document.querySelectorAll('[data-test]').forEach(b => b.onclick = () => { busy(b,true,'Testing\u2026'); setTimeout(()=>busy(b,false),1200); vscode.postMessage({type:'test',provider:b.dataset.test}); });
 document.querySelectorAll('[data-clear]').forEach(b => b.onclick = () => { savedPop(b); vscode.postMessage({type:'clearKey',provider:b.dataset.clear}); });
 $('testAll').onclick = () => vscode.postMessage({type:'testAll'});
 $('clearAll').onclick = () => vscode.postMessage({type:'clearAll'});
 $('openChat').onclick = () => vscode.postMessage({type:'openChat'});
 $('saveConfig').onclick = () => {
   const get = id => $(id).value;
   vscode.postMessage({ type:'saveConfig', config: {
     plannerProvider: get('cfg-plannerProvider'), plannerModel: get('cfg-plannerModel').trim(),
     editorProvider: get('cfg-editorProvider'), editorModel: get('cfg-editorModel').trim(),
     reviewerProvider: get('cfg-reviewerProvider'), reviewerModel: get('cfg-reviewerModel').trim(),
     applyProvider: get('cfg-applyProvider').trim(), applyModel: get('cfg-applyModel').trim(),
     autocomplete: $('cfg-autocomplete').checked,
     personalRules: get('cfg-personalRules'),
     mcpServersText: get('cfg-mcpServersText'),
   }});
 };
 window.addEventListener('message', e => { const m = e.data;
   if (m.type === 'notice') notice(m.text);
   if (m.type === 'state') {
     for (const [id, s] of Object.entries(m.status)) { const el = $('st-'+id); if (el && el.textContent !== s) { el.textContent = s; el.classList.remove('pop'); void el.offsetWidth; el.classList.add('pop'); } }
     const r = m.ready;
     $('ready').innerHTML = (r.chatReady
       ? '<span class="ok">✔ Ready to chat.</span> Press Ctrl+L (or “Open Akosua chat”) and describe your task.'
       : '<b>Almost there:</b> ' + [!r.hasPlannerKey ? 'save the API key for your Planner provider above' : null, !r.hasPlannerModel ? 'set a Planner model ID under Models, then Save' : null].filter(Boolean).join(' · '));
     if (!populated) { populated = true; const c = m.config;
       for (const k of ['plannerProvider','plannerModel','editorProvider','editorModel','reviewerProvider','reviewerModel','applyProvider','applyModel']) { const el = $('cfg-'+k); if (el) el.value = c[k] ?? ''; }
       $('cfg-autocomplete').checked = Boolean(c.autocomplete);
       $('cfg-personalRules').value = c.personalRules ?? '';
       $('cfg-mcpServersText').value = c.mcpServersText ?? '[]';
     }
   }
 });
 vscode.postMessage({type:'ready'});
</script></div></div></body></html>`;
}
