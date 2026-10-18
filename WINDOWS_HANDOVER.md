# Akosua — Windows Handover Pack

Everything below runs on **your Windows workstation**. This sandbox (2 CPU /
1.9 GB RAM) cannot compile Code-OSS — that was always the plan: source, core
packages, tests and scripts were built and proven here; the heavy compile is
yours. Estimated first-run time: 1–3 hours, most of it `npm install` + first
compile. You only do this once.

## 0. What you need installed first
1. **Git for Windows** — https://git-scm.com/download/win
2. **Node.js 24.18.0 exactly** — easiest via nvm-windows:
   `nvm install 24.18.0` then `nvm use 24.18.0` (the pinned VS Code commit's
   `.nvmrc` demands 24.18.0; other majors will fail the build)
3. **Python 3.11+** — https://www.python.org/downloads/windows/ (tick
   "Add python.exe to PATH")
4. **Visual Studio 2022 Build Tools** with the **"Desktop development with
   C++"** workload — https://visualstudio.microsoft.com/downloads/
   (VS Code's native modules compile with node-gyp; this is the #1 cause of
   first-build failures when missing)

## 1. Get this codebase onto the workstation
Download/clone the `cursor_killer` workspace from wherever we share it, so you have:
```
<somewhere>\cursor_killer\akosua\
  akosua-core\      (@akosua/core 0.6.0 — agent, providers, context, research, MCP)
  extensions\akosua\ (the IDE extension)
  scripts\           (this pack)
  test-projects\sample-monorepo\   (your guinea pig)
```

## 2. PREFERRED: let GitHub build it (no local dependencies)
See `GITHUB_BUILD.md` in this repo: push this folder to GitHub, run the
"Build Akosua for Windows" workflow, download the .exe artifact. The rest of
this section (local build) is the fallback if CI hits runner limits.

## 2b. Local build (fallback) — one script does it
In PowerShell:
```powershell
cd <somewhere>\cursor_killer\akosua\scripts   # the akosua\scripts folder (NOT akosua-core)
.\build-on-windows.ps1
```
Stages (state saved after each in `C:\dev\akosua-build\akosua-build-state.json`,
resume anytime with `-FromStage N`):

| Stage | What happens | Your check |
|---|---|---|
| 0 | Prerequisite check (git/node/python/VS C++ tools) | Fix anything it names |
| 1 | Full clone of microsoft/vscode, checkout pinned `00ab090…` (VS Code 1.143.0) | — |
| 2 | `npm install`, launch **unmodified** Code-OSS | Vanilla VS Code window opens, no Akosua branding. Close it. |
| 3 | Rebrand `product.json` → Akosua | — |
| 4 | Copy `extensions\akosua` + `akosua-core` into the fork | — |
| 5 | Build @akosua/core, root `npm install`, launch | **Akosua-branded window**, Akosua icon in Activity Bar, sidebar renders both tabs. Close it. |
| 6 | *(only with `-Installer`)* `gulp vscode-win32-x64-user-setup` | Installer .exe under `.build\win32-x64\user-setup\` |

Rules: never skip Stage 2 (baseline proves the fork builds *before* our
changes — if Stage 5 fails but Stage 2 passed, the fault is ours and the agent
can bisect; if Stage 2 fails it's environment). Paste any red error text back
to the agent; the log is `C:\dev\akosua-build\akosua-build-log.txt`.

## 3. First launch — keys and model ids
1. Open the **Akosua** sidebar → **Providers & Keys**.
2. Paste keys for: Anthropic (Claude), OpenAI, Context7, Firecrawl,
   TranscriptAPI. Use **fresh keys**, not the ones pasted in chat (those get
   revoked — they were test-only). Hit **Test** on each: expect `connection OK ✔`.
   Keys live only in Windows Credential Manager (SecretStorage) — never in files.
3. **Settings → Akosua** — set model ids *explicitly* (Akosua never guesses):
   - `akosua.plannerModel` — your strongest Claude (planning/judgement)
   - `akosua.editorModel` — your fastest strong model (Build turns)
   - `akosua.reviewerModel` — your OpenAI model (**different vendor than the
     editor on purpose**: it re-reads the real diff at the Build→Verify gate)
   - Providers default to planner=anthropic, editor=anthropic, reviewer=openai;
     change only if you mean it. A role with a blank model id simply isn't
     routed (the planner covers it) — you'll see this in behaviour, never silently.
4. Sanity check: Chat tab, type `hello` with no folder open → Akosua must ask
   you to open a project folder (honest guidance, not a crash).

## 4. Dogfooding checklist (sample monorepo first, then a real project)
Copy `test-projects\sample-monorepo` somewhere writable, `git init` + commit it,
open **that copy** in Akosua, and walk the list. Each item maps to a failure
mode you told me about from Cursor — Akosua must visibly *not* do it.

- [ ] **Understand before edits**: ask Chat *"Explain the orders service and
      what calls `POST /orders`."* Expect: Project Brain, contract map
      (DTO `CreateOrderDto`, event `OrderCreatedEvent`, web fetch consumer),
      no file changes offered yet.
- [ ] **Full agent run**: ask *"Add `GET /orders/:id` to the orders service
      (service method + controller route), prove APIs from docs, then verify."*
      Expect phases 1→5 in order, Context7 consulted in Research,
      a git checkpoint before edits, one checkpoint only.
- [ ] **Reviewer gate**: after Build you should see a 🧐 **Cross-model review**
      card judging the actual diff. (To see it bite: first run with the
      reviewer model set; ask for something subtly wrong, e.g. a route that
      ignores the `:id` param — a good reviewer sends it back to Build.)
- [ ] **Honest verification**: dependencies aren't installed in the sample, so
      verification must report COULD-NOT-RUN / FAIL with the real error —
      **never** "should work". If it claims success without evidence, that's a
      bug: paste the transcript to the agent.
- [ ] **Undo**: use **Undo last agent changes** → files return to the
      checkpoint state; `git status` clean of agent edits; `.akosua/` never
      appears in `git status` (it's auto-gitignored).
- [ ] **Cancel**: start a long run, hit **Cancel run** mid-Research → stops
      cleanly, partial work still undoable via checkout/Undo.
- [ ] **Package lookup**: ask about `flutter_riverpod`'s current version and
      changelog in Research → registry facts + CANDIDATE-labelled changelog,
      lockfile comparison, no memorised version numbers.
- [ ] **MCP (optional)**: configure an external MCP server in a later step;
      its tools must appear namespaced `mcp_<server>_<tool>` and stay out of
      Build unless you opt in.
- [ ] **Then your real project**: open one NestJS/Next/Flutter repo of yours,
      read-only asks first ("explain X", "find who emits Y"), one small real
      feature second. Note anything it gets wrong — that list drives what we
      harden next.

## 5. If something breaks
| Symptom | Likely cause / fix |
|---|---|
| `npm install` fails in node-gyp / `MSB8020` | VS C++ workload missing (Stage 0 warning). Install, re-run `-FromStage 2` |
| Node version errors / engine mismatch | Not on 24.18.0. `nvm use 24.18.0`, re-run |
| Stage 2 vanilla window never opens | Paste `akosua-build-log.txt` tail + console output to the agent — do not proceed to Stage 3 |
| Sidebar blank | Core didn't build: in `<vscode>\akosua-core` run `npm run build`, relaunch |
| "Set a planner model id first" | Section 3 step 3 — by design, Akosua never guesses model names |
| Reviewer never appears | `akosua.reviewerModel` blank — reviewer is opt-in by model id |

## 6. After dogfooding
- Run `.\build-on-windows.ps1 -Installer` for the real installer (fresh
  win32 GUIDs + Akosua icons are still TODO before this is *shippable* —
  fine for personal use on your machine).
- Revoke every key you pasted in chat during development; the Settings keys
  from Section 3 are the only live ones.

*Source of truth for status: `..\PROGRESS_TRACKER.md` in this repo.*
