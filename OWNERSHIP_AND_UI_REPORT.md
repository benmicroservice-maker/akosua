# Akosua — Ownership & UI Research Report

**Date:** 18 October 2026
**Commissioned by:** User concern — "Akosua feels like VS Code with an extension bolted on, not our own app like Cursor. The UI is bad. Research, don't code."
**Status:** Research only. No code was changed for this report.

---

## Verdict up front

**You are right, and the evidence supports you.** What we ship today is, architecturally,
a VS Code (Code-OSS) build with (1) a product.json rebrand and (2) a bundled extension.
Cursor is *not* that. Cursor, Windsurf, and Void all modify VS Code **at the source level**
— the AI lives in the editor's own workbench code, not in an extension. Cursor's team states
the reason plainly: *"VS Code extensions have very limited control over the UI of the editor
unfortunately (our Command-K and Copilot++ features aren't possible as extensions, same for
much of what we want to build in the future!)"* [Cursor forum](https://forum.cursor.com/t/vs-fork-question/5105).

The good news: we already own the two most expensive assets — a working Windows fork build
pipeline on CI, and a well-tested agent core (`@akosua/core`, 37/37 tests). Moving the UI from
"extension" to "native part of the app" is a **known, travelled road** (Void walked it in public,
open source). It is a UI/architecture migration, not a restart.

---

## 1. What we actually own today (honest audit)

| Layer | State | Evidence |
|---|---|---|
| App name / data folders / mutex / protocol | ✅ Akosua | `scripts/rebrand_to_akosua.py` rewrites 20+ product.json fields |
| Installer | ⚠️ Works, but file is still named `VSCodeSetup.exe` | GitHub artifact inspection |
| App icons | ❌ Still stock VS Code artwork | Rebrand script itself notes icons "still need Akosua artwork" |
| Default layout, activity bar, welcome experience | ❌ Stock VS Code | No fork patches to workbench defaults |
| Settings experience | ❌ VS Code Settings editor + extension fields | Akosua keys/models are raw settings entries |
| AI chat UI | ⚠️ One hand-rolled HTML page | `extensions/akosua/src/extension.ts` `html()` — inline CSS, two tabs, raw `<textarea>` |
| Agent engine (phases, tools, checkpoints, review) | ✅ Fully ours, tested | `@akosua/core` 37/37 |
| Inline diff rendering, autocomplete, editor-integrated AI | ❌ Absent / extension-limited | Not possible via public extension API |

**Why the Akosua panel looks "off" compared to the rest of the app** — this is structural, not
a lack of CSS effort:

1. Microsoft *forbids* extensions from touching the real UI: "extensions cannot access the DOM
   of VS Code UI. You **cannot** write an extension that applies custom CSS to VS Code or adds
   an HTML element to VS Code UI" ([Extension Capabilities Overview](https://code.visualstudio.com/api/extension-capabilities/overview)).
2. The only custom UI an extension may build is a **Webview** — a sandboxed iframe with its own
   document, theme CSS variables passed in from outside, and message-passing (`postMessage`) for
   every interaction ([Webview API](https://code.visualstudio.com/api/extension-guides/webview)).
   VS Code's own UX guidelines warn webviews "run the risk of appearing and behaving differently
   than the rest of Visual Studio Code" ([Webview UI Toolkit](https://github.com/microsoft/vscode-webview-ui-toolkit)).
3. Our webview is one inline HTML string: no component library, no Codicons icon font usage in
   most places, mixed emoji markers (🔧 🧐), a settings form and a chat crammed into one panel
   behind two hand-made tabs. It *cannot* feel native because, by Microsoft's design, it isn't.

## 2. How the products you admire actually did it

### Cursor (the benchmark)
- Direct fork of Code-OSS since 2022 — "We needed to own our editor… the Tab model would have
  been very difficult without that fork" ([Inside Cursor 3](https://medium.com/@ayush.s0410/inside-cursor-3-the-architecture-of-an-agent-first-ide-in-2026-60c681a8df1d)).
- Owning the fork = owning the **rendering pipeline**: custom inline diff views, speculative
  completions, shadow workspaces — features analyses describe as "physically impossible for a
  plugin" ([MMNTM Deep Dive](https://www.mmntm.net/articles/cursor-deep-dive), [The AI Engineer](https://theaiengineer.substack.com/p/how-cursor-actually-works)).
- Cursor 3 (Apr 2026) went further: a second, **from-scratch Agents Window** — conceding VS Code's
  file-editor-terminal model strains under multi-agent work, they built their own surface.

### Windsurf
- Also a full VS Code fork; Cascade is "not a chat window… it is an agent" *baked into the editing
  environment at every layer*, with flow-awareness tracking editor/terminal/clipboard history
  ([Windsurf review](https://vantaige.io/ai-tool/windsurf), [Miraheze](https://ai.miraheze.org/wiki/Windsurf)).
- Adopted the fork for the same stated reasons: extension APIs limit integration with file
  watching, terminal, LSP pipeline, and undo stack.

### Void (our most useful reference — open source, archived Jun 2026)
Void is the closest public blueprint to what Akosua should become, and its README explicitly
offers itself as "one of the best references to use when forking VS Code":
- **All AI code isolated in one directory:** `src/vs/workbench/contrib/void/` — renderer services
  + UI, a `common/` shared-types layer, and Electron-main services for LLM/MCP calls
  ([DeepWiki](https://deepwiki.com/voideditor/void), [zread architecture](https://zread.ai/voideditor/void/9-architecture-overview)).
- **React + Tailwind mounted into the workbench** — "not possible in plain VS Code, and required
  extending the build pipeline" (scoped Tailwind classes to avoid VS Code CSS collisions, bundled
  with tsup) ([Void repo](https://github.com/voideditor/void)).
- Real workbench services (`IChatThreadService`, `IEditCodeService`, `IToolsService`…) — chat,
  streaming diffs, and autocomplete as *citizens of the editor*, with IPC to the main process where
  Node/SDKs live.
- Even a YC team found the fork deep-end "pretty involved" — VS Code's contribution system is
  OOP/DOM-based, no React by default ([Show HN](https://news.ycombinator.com/item?id=41563958)).
  Budget for that learning curve honestly.

## 3. The ownership ladder (where we are, where Cursor is)

| Level | Description | Who lives there |
|---|---|---|
| **L0 Rebrand** | product.json names, folders, gallery | ✅ Akosua today (+VSCodium stays here deliberately) |
| **L1 Extension** | AI as a bundled extension + webview | ✅ Akosua today |
| **L2 Native module** | AI as a workbench contribution inside `src/vs/workbench/contrib/akosua/`, native views, commands, settings; agent core reused as-is | **Void** — recommended Akosua target |
| **L3 Shell takeover** | Branded first-run/onboarding, default layout AI-first, custom icons everywhere, installer name, about/splash, default theme accents, own settings pages, removed/replaced stock surfaces where they fight the product | Cursor / Windsurf day-to-day feel |
| **L4 Product moat** | Custom completion model, indexing service, agent window, proprietary UX research | Cursor 3 territory — out of scope for personal use today |

## 4. Options considered

### A. Polish the extension only (keep L1)
Rebuild the webview UI properly (component discipline, `--vscode-*` tokens everywhere, Codicons,
better layout, separate Settings page vs Chat, streaming states, skeletons). **Fast and safe —
but the ceiling is Microsoft's:** still an iframe guest, still no editor-native diffs, still
"VS Code + guest panel". This fixes *ugly*, not *ownership*.

### B. Hybrid (L1.5) — polish + fork-level defaults
A plus cheap fork wins we haven't taken: Akosua icons/installer naming, branded welcome page,
sensible default layout (Akosua view primary), default settings/theme accents, GUID refresh.
Makes it *look* like our app on day one; AI still an extension inside. **Good interim visible win.**

### C. Void-style native workbench module (L2 → L3) ⭐ recommended target
Create `src/vs/workbench/contrib/akosua/` in the fork: native sidebar/panel views for Chat,
Plan approval, Tool activity, Diff review; services bridging to `@akosua/core` logic; native
Settings integration; editor decorations for build changes. Extension kept as fallback until
parity, then retired. Changes stay in one contrib folder + minimal registration patches —
deliberate, because fork maintenance is a *permanent monthly tax*: "Every fork has to
continuously merge upstream changes… an under-resourced one drifts" ([VS Code forks landscape](https://www.vgtc.io/insights/vs-code-forks-ide-landscape-2026-h1)).
Isolation is how small forks survive rebases.

### D. Cursor-3 style from-scratch window
Design an agent-first surface beside the editor. Inspirational later; **not** the next step for a
personal, single-developer product.

## 5. Design direction (using VS Code's own design system, per your instruction)

The rule that fixes "uniformity": **build Akosua surfaces from the workbench's own vocabulary** —
same parts Cursor kept even while owning everything else:

- **Containers:** Activity Bar view container (Akosua icon, Codicon), Secondary Sidebar for the
  agent, Panel for run logs — no custom chrome.
- **Controls:** workbench buttons/inputs/dropdowns, Codicons only (no emoji in UI), Quick Picks
  and native Notifications/Progress for approvals and long runs, Status Bar item for agent state
  (phase, model, checkpoint).
- **Settings:** native Settings-editor entries grouped under an "Akosua" section, with the
  Providers & Keys flows as *guided* native-feeling pages (keys still in SecretStorage).
- **Signature UX moments** (where Akosua should feel *better* than stock, not different-looking):
  the 5-phase progress as a first-class stepper; PLAN APPROVED as a native inline action;
  diff review in VS Code's own diff editor with Keep/Undo in the title bar; checkpoint timeline
  as a TreeView; research citations as hover/link surfaces.
- **Identity:** one accent color carried through icon, installer, welcome page, and the phase
  stepper — identity by *accent and behaviour*, while layout/typography/spacing stay 100% VS Code.

## 6. Costs & risks (honest)

- **Upstream merge tax is forever.** Monthly VS Code releases; our contrib isolation + CI smoke
  builds are the mitigation, not a cure. Fork-based cost analyses are blunt about this being the
  dominant long-term cost ([thenuralbase](https://theneuralbase.com/llm-for-coding/learn/beginner/vs-code-fork/)).
- **React-in-workbench adds build complexity** (Void needed scoped-Tailwind + tsup stages). The
  low-risk variant is VS Code's native TypeScript/DOM component style — less pretty tooling, zero
  extra pipeline. Decide deliberately, once.
- **Extension-universe caveats stay:** Open VSX gallery, no Microsoft proprietary extensions in
  forks ([VSCodium README discussion](https://github.com/VSCodium/vscodium)) — unaffected by UI work.
- **Signing/updater** remain Phase-7 debts (unsigned installer + SmartScreen friction, as we saw).
- **Scope discipline:** personal-use product; L4 (custom tab model etc.) stays explicitly out.

## 7. Recommended path (no code yet — for your approval)

1. **UI-0 — Design spec first.** A short DESIGN.md: layout map, component inventory, colour/icon
   identity, the five signature moments, screenshots of Cursor/Void reference points. You approve
   the target before a line moves.
2. **UI-1 — Visible ownership (Option B).** Icons, installer name, welcome, defaults. One CI cycle,
   immediate "this is Akosua" effect on launch.
3. **UI-2 — Native module spike (Option C, minimal).** `contrib/akosua` with Chat + phase stepper
   + run controls, talking to the existing core; extension hidden behind it. Proves the architecture
   on one screen.
4. **UI-3 — Native depth.** Settings pages, diff-review in native diff editor, checkpoint TreeView,
   status bar agent state. Retire the webview.
5. **UI-4 — Editor-native AI (only then).** Inline edit affordances, decorations, later autocomplete —
   the features that were *never* possible at L1.

**Decision needed from you before UI-0:** (a) target = Option C as above? (b) AI home = right
(Secondary Sidebar, Cursor-style) panel as primary? (c) React (Void-style) vs native VS Code DOM
components (lower maintenance)? My recommendation: C + secondary sidebar + native components first,
React only if the design spec proves we need it.
