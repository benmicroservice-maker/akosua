# AKOSUA — Progress Tracker
Status key: [ ] todo · [~] in progress · [x] done · [!] blocked (needs user)
Last updated: 2026-10-18 (local-first build program, see akosua/BUILD_PLAN.md). Track A (harness v2,
core 0.8.0, 43/43 tests) SHIPPED locally; Track B native UI overlay (chat + Project Brain views, plan
cards, .akosua/runs artifacts) written and patch-tested against the pinned clone; the Local Completion
Gate passes except items that inherently need the real VS Code compile (fork TS) and UI-6 (agent-host
migration, deferred by design). Next: ONE CI run for the fork overlay — only on the user's word.

## COMPLETION ESTIMATE (2026-10-18, honest, weighted by phase)
**~75% of the full vision.** Core engine + panel + research (the parts that run and are
live-tested) ≈ 85% done. Remaining ≈30% is concentrated in: full Code-OSS compile +
Windows installer (Phase 1/7, runs on user's Windows workstation — cannot be done in
this sandbox), Reviewer cross-vendor wiring in the loop (Phase 5), MCP client +
package/changelog lookup (Phase 4), packaging/auto-update/dogfooding (Phase 7).
Phase 4 now 100%. Next sandbox-doable: dogfood-prep (sample real-stack project + scripted Windows handover pack). Phase 8 (optional backend) excluded from the percentage.

## Phase 0 — Inputs & Decisions
[x] User confirms this plan + backend answer ("Nobody can even make this better")
[~] API keys: user will paste in chat AT LIVE-TEST TIME only (never written to files/repo; revoked after project finishes). Build proceeds key-free until then. TranscriptAPI key already provided+confirmed for Akosua.
[x] Windows dev environment: powerful workstation, user says do not worry about specs
[x] GitHub repo decision: user will create the private repo himself; he will download the codebase built here
[x] Test project: clarified — we will generate synthetic test projects; user will use Akosua for real afterwards
[x] Default model assignments (assistant recommendation, user did not object): Planner=strongest Claude, Reviewer=OpenAI (cross-check), Editor=fastest strong model — all changeable in Settings

## Phase 1 — Fork Foundation
[~] Clone Code-OSS at a pinned version; get it compiling/running unmodified (Windows recipe scripted) — IN PROGRESS. NOTE: agent sandbox = 2 CPU / 1.9GB RAM / 21GB disk, so the full Code-OSS compile + Windows installer will be run on the user's powerful Windows workstation using scripts prepared here; sandbox is used for source, patches, Akosua core packages and tests.
[~] Rebrand to Akosua — rebrand script written+tested on pinned Code-OSS 1.143.0 (00ab090, product.json verified, test reverted). Icons/GUIDs still TODO (Phase 7). Windows setup script written (setup-windows.ps1, Node 24.18.0 pin from .nvmrc). Full clone+compile happens on user's Windows workstation.
[ ] Prove we can build a Windows installer build locally

## Phase 1.5 — Akosua Core packages (framework-independent, tested in sandbox)
[x] @akosua/core v0.1.0: Claude+OpenAI streaming providers (SecretStore-only keys), phase-gated agent loop (Understand->Research->Plan->Build->Verify, mutations blocked outside Build), file_editor (surgical str_replace), research tools (Context7/Firecrawl/YouTube native clients + TTL cache)
[x] Stack fingerprinting v1: NestJS+Fastify/NATS/Prisma monorepo + Flutter/Riverpod detected from evidence; Project Brain renderer
[x] Tests: 9/9 passing, zero network, zero API keys (mocked providers/fetches)
[x] Terminal + git tools: PersistentTerminal (shell detection PowerShell/GitBash/WSL/bash, cwd+env persist, exit-code markers), git checkpoints via temp-index commit-tree to refs/akosua/checkpoints/* (working tree/index/branch untouched, diff verified)
[x] Verify runner: executes fingerprinted verify+test commands, PASS/FAIL evidence report (failures visible)
[x] Context engine v2: structural indexer (symbols/imports, Nest @Controller/@Get/@EventPattern, Next route handlers, Flutter widgets + Riverpod providers), sha256 incremental re-index, contract map (HTTP + events), Brain v2 renderer
[x] Synthetic fixture monorepo (cursor_killer/test-projects/sample-monorepo): NestJS+Fastify+NATS+Prisma orders service + Next.js web + Flutter/Riverpod mobile — indexed in tests
[x] Tests now 13/13 passing (incl. real-fixture indexing; a silent-skip test was caught + fixed, and an `exit`-kills-shell test bug was caught + fixed)
[x] Agent assembly + Understand tools: project_brain / list_files / search_code (absence returns honest evidence), buildAkosuaAgent() wiring ALL tools (editor, terminal, checkpoint, Context7/Firecrawl/YouTube, run_verification)
[x] E2E test: scripted agent walks Understand->Research->Plan->Build->Verify on a real temp project, gated tools fire in order, file created, verification run
[x] Design bug fixed: fingerprinter no longer adds bare `npx tsc` to non-TS projects (would download+prompt = hang); terminal sessions now close properly (leak hung the test host — caught + fixed). Tests: core 15/15

## Phase 2 — Akosua Shell (AI surface)
[~] Akosua AI sidebar: built as a BUILT-IN EXTENSION first (Activity Bar webview Chat + Providers tabs) — compiles clean against @akosua/core; graduating to Void-style React workbench contrib is a later polish step
[x] Settings -> Providers & Keys: VS Code SecretStorage (Windows Credential Manager) for Claude/OpenAI/Firecrawl/Context7/TranscriptAPI, Save/Test/Clear in-panel + Command Palette commands, model routing settings (planner/editor/reviewer, blank model never guessed)
[x] AGENT IN THE PANEL: sidebar Chat now runs the phase-gated Akosua agent on the open workspace (buildAkosuaAgent via dynamic core import), streaming events to the webview
[x] Phase progress UI: Understand→Research→Plan→Build→Verify indicator in the Chat tab, live text streaming, tool-call cards (result truncated), done notice. Requires planner model setting + provider key + an open folder (each missing piece gives a specific, honest message)
[x] Integration: install-into-codeoss.ps1/.sh copies extension+core into a full Code-OSS clone (verified against pinned sparse clone)

[x] Cancellation: Agent.cancel() stops between turns/tools with a `cancelled` event; sidebar Cancel button wired (in-flight stream finishes its turn, no new tool calls start)
[x] Diff review + Undo: host auto-creates a git checkpoint BEFORE every agent run; on completion the panel shows the diff-stat since checkpoint and an **Undo last agent changes** button (core restoreCheckpoint: tracked files restored + agent-created files removed, tested)
[x] Semantic search: chunked local embeddings (HashEmbedder, camelCase-aware tokenizer) + cosine search, `semantic_search` tool in Understand/Plan/Build; ranked Nest controller + Flutter Riverpod screen correctly on the fixture (real OpenAI embeddings adapter can replace HashEmbedder later)
[x] Core tests: 18/18

## Phase 3 — Context Engine (Understand)
[x] Stack fingerprinting v1 (NestJS/Fastify incl. transports NATS/Kafka/RabbitMQ/Redis/gRPC/TCP from deps, Next.js, Flutter/Riverpod, Python via pyproject/requirements, monorepo shape, TypeORM/Prisma) — regex/evidence v1; tree-sitter/LSP upgrade is later polish
[x] Project Brain generator + file/symbol index (regex v1; tree-sitter/LSP upgrade later); incremental re-index (hash-based)
[x] Semantic index (local hash embeddings v1) + contract map v3: full route paths (controller prefix joined), **DTO payload shapes** (TS classes/interfaces + Prisma models), API consumers (fetch/axios/http call sites) — Brain renders DTOs + who-calls-what, verified on fixture

[x] Research cache hardening: PersistentTtlCache at .akosua/research-cache.json (7-day TTL, 500-entry eviction, prefix invalidation, race-free flush), shared across Context7/Firecrawl/YouTube in assembled agents; keys embed library@version so version bumps naturally miss cache
[x] Core tests: 20/20
[x] **First LIVE test PASSED (gpt-4.1, real OpenAI key, in-memory only)**: full Understand->Research->Plan->Build->Verify on a copy of the sample monorepo — NestJS getById endpoint implemented exactly, Context7 used for @Param docs, **verification failure reported honestly** (deps missing) instead of false success. Three failed attempts before it diagnosed loop bugs (multi-signoff, sign-off punctuation, 0-indexed view_range, phase looping) — all fixed in the harness + regression-tested; unit suite now 21/21. Full report: akosua/LIVE_TEST_REPORT.md
[x] Follow-ups from live test DONE (suite now 24/24): `createGitCheckpointTool()` = one checkpoint per agent session (repeats return the same ref; git-tested exactly 1 ref); `ensureAkosuaStateIgnored()` auto-adds `.akosua/` to .gitignore in git projects (idempotent, no-op outside git; wired into buildAkosuaAgent); system prompt rule 6 = PASS/FAIL/COULD-NOT-RUN are separate outcomes, 'correctness is UNKNOWN' when checks couldn't run, 'no errors detected' forbidden. Suite 24/24 at that point
[x] **Native research live test PASSED**: Context7 key + Firecrawl key (chat-supplied, env-only, never filed) — Context7 returned current NestJS @Param docs, Firecrawl search returned docs/StackOverflow, scrape returned 35k chars of docs.nestjs.com. Report: akosua/RESEARCH_LIVE_TEST.md. YouTube/TranscriptAPI: first re-sent key dead (401 all auth variants, raw curl); user supplied a NEW key -> accepted, which exposed a real client bug (search wants `q` not `query`) — fixed per current docs + friendlier search output, suite 21/21, then live PASSED: 10 NestJS/NATS results + 24k-char timestamped transcript, IDEAS-ONLY labelling intact. All research natives now live-verified (Context7/Firecrawl/YouTube).

## Phase 4 — Research Tools (native, not MCP)
[x] Context7 native (version-pinned docs, cache per library@version) — LIVE-verified 2026-10-18
[x] Firecrawl native (docs fallback + online implementations/solutions search, cache) — LIVE-verified (search + scrape)
[x] YouTube Knowledge native via TranscriptAPI (search -> transcript -> cited ideas) — LIVE-verified after `q`-param API fix
[x] **MCP client (external servers)**: stdio JSON-RPC client (`src/mcp/client.ts`, core 0.4.0), tools namespaced `mcp_<server>_<tool>`, exposed in Understand/Research only by default (`allowBuild` opt-in per server), wired into buildAkosuaAgent with per-server failure reporting (`mcpErrors`, never silent) + close() cleanup. Tested against a fake MCP server (list/call/phase-block): suite 25/25, extension still compiles 2/2
[x] **Package/docs/changelog lookup (core 0.6.0)**: `package_lookup` native over npm/pub.dev/PyPI public registries (no key): latest version + publish date, repo/docs/homepage, recent versions, changelog (registry-provided or CANDIDATE-labelled — never presented as fact), lockfile-compare instruction baked in. **Phase 4 COMPLETE.** Unit-mocked (30->31 with gate below) + LIVE-verified: @nestjs/platform-fastify 12.1.3, flutter_riverpod 3.4.3, fastapi 0.143.5 + honest not-found.

## Phase 5 — Agent Engine (enforced workflow)
[x] 5-phase state machine: Understand -> Research -> Plan -> Build -> Verify (tool gating per phase, sign-off enforced, budgets/nudges/repeat-guard from live testing)
[x] Tools: persistent terminal (PowerShell/Git Bash/WSL), surgical file_editor, git checkpoint (1/session) + diff review + Undo in panel
[x] **Planner/Editor/Reviewer routing + cross-vendor review (core 0.5.0, 28/28)**: loop routes Understand/Research/Plan/Verify turns to Planner, Build turns to Editor (`routeFor`, unit-proven: editor gets exactly the Build turn). **Reviewer gate at Build->Verify**: independent reviewer model (no tools) judges task + builder summary + REAL git diff (`reviewEvidenceSinceCheckpoint`); `REVIEW VERDICT: CHANGES REQUESTED` sends the agent back into Build with findings (max 2 rounds, then Verify proceeds with concerns disclosed — never an infinite loop); reviewer outage = `unavailable` event + history disclosure 'do not claim the work was reviewed'. Panel wires editor/reviewer from Settings (only when model ids explicitly set) and renders 🧐 review cards.

## Phase 6 — Verify Gates
[~] Per-stack verify detected from fingerprint (tsc/ESLint/Jest, python -m ruff check ./python -m pytest -q, flutter commands when Flutter detected) with PASS/FAIL/COULD-NOT-RUN evidence — done for detected commands; deeper per-stack gates (Next build, flutter analyze on your real projects) to be proven in dogfooding (Phase 7)
[x] Bug protocol: reproduce-first in prompt + **loop-level Verify gate (core 0.6.0)**: `VERIFICATION COMPLETE` sign-off is mechanically REJECTED until `run_verification` has executed in the Verify phase (PASS/FAIL/COULD-NOT-RUN all count as evidence; claiming without running does not). Blocked max 2x, then run ends flagged 'correctness is UNVERIFIED' rather than looping. Dedicated gate test + e2e prove it. Suite 31/31, extension 2/2

## Phase 7 — Speed, Polish, Packaging
- [x] **CI pre-flight source audit (2026-10-18)**: verified against pinned VS Code source in sparse clone — gulp task `vscode-win32-x64-user-setup` EXISTS but does NOT compile (Inno-packages ../VSCode-win32-x64 from `vscode-win32-x64-min`); CI script fixed to run min-compile first, then setup (would have failed first try otherwise). Also embedded @akosua/core as a REAL copy in extensions/akosua/node_modules (extension packager globs node_modules; the file: symlink out of extensions/ risked being dropped from the product). Inno Setup comes from the repo's own innosetup npm package. Bundle re-committed + re-zipped.

- [x] **GitHub CI build pack (2026-10-18)**: `.github/workflows/build-akosua-windows.yml` (workflow_dispatch with runner+smoke_only inputs, tag->Release, artifact upload) + `scripts/ci-build-windows.ps1` (shallow pinned clone 00ab090 in-runner, rebrand, overlay install, core build, gulp vscode-win32-x64-user-setup, per-stage disk reporting; PS+YAML validated) + `.gitignore` (repo push ~300 KB, code-oss/node_modules excluded) + `GITHUB_BUILD.md` (feasibility: VSCodium precedent; public repo = free 4CPU/16GB unlimited, private = 2CPU/8GB + $0.010/min after 2,000 free min; fallbacks Depot/WarpBuild labels, split build, local). Owner created PUBLIC repo https://github.com/benmicroservice-maker/akosua (verified via API: public, empty, main) -> free unlimited Actions on 4CPU/16GB standard runner applies. Push-ready bundle prepared at cursor_killer/akosua-push/ (git repo, remote set, 2 commits) + akosua-push.zip (250 KB) + PUSH-ME.ps1 (git-only push, no Node/VS needed). NEXT: owner downloads zip, runs PUSH-ME.ps1, dispatches workflow smoke_only first. Local handover pack remains fallback.

- [x] **GOAL AUDIT (2026-10-18, core 0.7.0)**: full codebase re-checked against SPEC_BRAINSTORM original goal. 6 defects found+fixed+regression-tested (31->36 core, 2->3 ext): D1 empty verification reported PASSED -> COULD-NOT-RUN; D2 terminal usable in Understand bypassed phase gate -> Build/Verify only; D3 fingerprinter missed nested monorepo manifests (Flutter apps/mobile) -> depth-3 scan; D4 MCP unreachable from IDE -> akosua.mcpServers setting+parser; D5 no persistent rules -> AKOSUA_RULES.md + personalRules injected per run; D6 file_editor sibling-prefix path escape -> separator-aware. Report: akosua/AUDIT_REPORT.md. Verdict: core workflow goal achievable; NOT yet Cursor parity (no AI autocomplete, browser/DB tools, tree-sitter, neural embeddings, parallel sub-agents); Windows compile still unproven until workstation Stage 2.

- [x] **Windows handover pack (2026-10-18)**: `akosua/scripts/build-on-windows.ps1` — resumable 7-stage orchestrator (prereqs Node 24.18.0/VS C++ → full clone @ pinned 00ab090 → npm install + UNMODIFIED baseline gate → rebrand → install ext+core → build core + Akosua launch → optional `-Installer` gulp user-setup), per-stage state JSON + log, `-FromStage N` resume, `-Force` unattended; PS structurally validated (balanced, PS5.1-safe, sibling scripts resolve). `akosua/WINDOWS_HANDOVER.md` — prereqs, keys (FRESH keys only; chat keys revoked), explicit planner/editor/reviewer model ids, 8-item dogfooding checklist on sample-monorepo copy (Understand-only ask, full run, reviewer-gate bite test, honest verify, Undo, Cancel, package_lookup, MCP), troubleshooting table. NOT YET RUN — awaits user's Windows workstation.

[ ] Rust sidecar for indexer/watcher/search if profiling shows need; prompt/research caching; parallel sub-agents
[ ] Windows installer, auto-update (GitHub Releases), first-run setup wizard
[ ] Dogfooding: build a real feature in user's own project with Akosua end-to-end

## Phase 8 — OPTIONAL later
[ ] Self-hosted personal backend (only if cross-machine sync / always-on background agents wanted)

## 🎉 WINDOWS INSTALLER BUILT VIA GITHUB CI (2026-10-18)
- Full build run **#39134404687 SUCCEEDED** (~22 min): clone -> rebrand -> core build -> VS Code npm install -> `vscode-win32-x64-min` compile (Akosua extension bundled via esbuild incl. @akosua/core) -> `vscode-win32-x64-inno-updater` -> `vscode-win32-x64-user-setup`.
- Artifact: **Akosua-Windows-Installer** (204.5 MB, 30-day retention, expires 2026-11-17). Download from the run page: https://github.com/benmicroservice-maker/akosua/actions/runs/39134404687
- Fixes that got us here: (1) core declares typescript/@types/node devDeps, (2) ASCII-safe rebrand output, (3) extension **bundled with esbuild** + `extensions/akosua` registered in VS Code's `build/npm/dirs.ts` (dropped the manual node_modules embed that made `npm ls` report @akosua/core invalid and abort the min compile), (4) run `vscode-win32-x64-inno-updater` before user-setup (code.iss needs tools/inno_updater.exe).
- NEXT: user downloads + installs on Windows (unsigned -> SmartScreen 'More info' -> 'Run anyway'), launches Akosua, adds fresh provider keys in Settings (DO NOT reuse chat-pasted keys), dogfoods per WINDOWS_HANDOVER checklist. Revoke the temporary GitHub token.
- Overall estimate now ~80%: Phase 1 fork/installer proven-built; remaining = on-Windows runtime verification, then Phase 7/8 items.

## UI OVERHAUL PROGRAM (approved 2026-10-18)
Owner verdict: Akosua must feel like OUR app (Cursor/Antigravity benchmark), not VS Code+extension.
Decisions (ask_user): native VS Code workbench components; agent chat in right Secondary Sidebar;
rollout spec->branding->native chat; engine priority = stack packs (NestJS/Next/Flutter/Data/Python).
Research: OWNERSHIP_AND_UI_REPORT.md. Design spec: akosua/DESIGN.md (UI-0, awaiting owner go).
Chat must render: phase stepper, step ledger, tool-call cards (incl MCP), plan-gate card,
change-set + native diff review, cross-model review card, verification card, checkpoint chip,
Brain card, artifacts persisted to .akosua/artifacts/. Phases UI-1..UI-6 in DESIGN.md s8.

## UI-1 IDENTITY SHIPPED + HARNESS RESEARCH (2026-10-18)
- HARNESS_RESEARCH.md: Cursor's edge = context engine (Merkle sync, tree-sitter chunks, own
  embeddings, dual semantic+regex index), Fast Apply + lint feedback loop, prompt/tool craft,
  compaction/JIT context (Anthropic). Akosua gaps ranked: retrieval quality, compaction,
  diagnostics-after-edit loop. Playbook H1-H7 incl. stack-specialisation + private benchmark.
- UI-1: owner-picked gold-A icon; brand/ assets (ico multi-size, tiles, png); rebrand installs
  code.ico/tiles and renames installer OutputBaseFilename -> AkosuaSetup. CI run #39143332155
  SUCCESS; artifact verified to contain AkosuaSetup.exe (205.4 MB).
- NEXT: UI-2 native contrib/akosua chat (fork patches applied in CI), per DESIGN.md s8.

## LOCAL-FIRST BUILD PROGRAM (2026-10-18, owner directive: NO GitHub Actions until local completion gate)
BUILD_PLAN.md governs. Track A harness v2 SHIPPED in @akosua/core 0.8.0 (43/43 tests):
A1 context compaction/budgets, A2 error-first tool-result shaping, A3 diagnostics-after-edit
(tsc/flutter analyze parsed back to agent), A4 syntactic symbol chunking, A5 prompt craft
(never speak tool names, explain-before-call, root-cause), A6 stack packs v1 (NestJS/Next/
Flutter-Riverpod/ORM/Python rules+playbooks+research routing, injected from fingerprint),
A7 private benchmark (offline 3/3). Remaining: Track B native UI (UI-2..UI-6 fork patch set),
Track C. CI frozen until BUILD_PLAN Local Completion Gate passes.
