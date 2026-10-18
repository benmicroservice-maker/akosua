# Akosua — Build on GitHub, Download the .exe

You are right to want this: **your PC should receive a finished installer, not
a dependency avalanche.** This is GitHub Actions doing the Windows compile on
Microsoft's runners. Verdict from the feasibility check (2026-10-18):

## Feasibility: YES, with one honest risk
- **Proven pattern**: VSCodium builds the same VS Code codebase on GitHub's
  Windows runners for its releases. Our workflow does the same dance:
  shallow-clone microsoft/vscode at our pinned commit *inside the runner*
  (your repo stays small — a few MB, no 2 GB fork upload), rebrand, overlay
  Akosua, `npm install`, `gulp vscode-win32-x64-user-setup`, upload the .exe
  as a run artifact (30-day retention) or Release asset on `v*` tags.
- **The toolchain is already on the runner**: windows-2022 images ship
  Visual Studio 2022 + C++ workloads, Inno Setup, Git. We add Node 24.18.0
  (exact, pinned) + Python via setup actions. You install **nothing**.
- **The risk is the free private runner's size**: GitHub's standard Windows
  runner is **4 CPU / 16 GB / 14 GB SSD for public repos, but only
  2 CPU / 8 GB / 14 GB for private repos**. A VS Code compile is the biggest
  mainstream OSS build there is; on the private runner it may be slow
  (1.5–3 h) and could hit disk or memory limits. Mitigations already in the
  workflow: shallow clone (saves GBs), disk reporting at start/end of every
  stage (failures will be diagnosable, not mysterious), 350-min timeout.

## Your one decision: public or private repo?
| | Public repo | Private repo |
|---|---|---|
| Runner | 4 CPU / 16 GB | 2 CPU / 8 GB |
| Actions cost | **Free, unlimited** (standard runners on public repos) | 2,000 free min/mo (Free plan), then **$0.010/min** Windows (~$1–2 per 2 h build) |
| Success odds first try | Best free option | Might need the fallback below |
| Exposure | Your Akosua overlay code is world-readable (it's built on MIT Code-OSS; contains NO keys — keys only ever live in the IDE's Credential Manager) | Only you |

Private-repo fallbacks if the standard runner chokes (in order):
1. **Third-party runner services** (Depot/WarpBuild/Namespace — drop-in
   `runs-on` labels, bigger Windows disks 100 GB+, ~$0.016/min): the
   workflow's `runner` input already accepts a custom label.
2. **Split build** (compile on Linux, package on Windows) — what Microsoft's
   own CI does; more workflow surgery, ask the agent if needed.
3. Local build (the old handover pack) — your powerful workstation, last resort.

## Do it (5 steps)
1. Create the GitHub repo (your call above), e.g. `akosua`.
2. Push **this folder** (`akosua/`, the one containing `akosua-core/`,
   `extensions/`, `scripts/`, `.github/`) as the repo root. The included
   `.gitignore` already excludes the 178 MB `code-oss/` reference clone,
   `node_modules`, build output — the push is small.
   ```bash
   cd <path-to>/akosua
   git init && git add -A && git commit -m "Akosua overlay + CI build"
   git branch -M main
   git remote add origin https://github.com/<you>/akosua.git
   git push -u origin main
   ```
3. On GitHub: **Actions → "Build Akosua for Windows" → Run workflow.**
   First time, tick **smoke_only** (clone+rebrand+deps only) to prove the
   chain cheaply; then run again without it for the real installer.
4. Watch the log (or paste failures back to the agent — every stage prints
   free disk, and errors keep stage context).
5. Download **`Akosua-Windows-Installer`** from the finished run's page →
   run the .exe → first launch per `WINDOWS_HANDOVER.md` §3 (fresh keys,
   model ids) → dogfooding checklist §4.

Notes: unsigned installer (personal use — SmartScreen will warn once,
"More info → Run anyway"; code-signing cert is a Phase-7 nicety, not a
requirement). Icons/GUIDs are still dev placeholders, fine for your machine.
