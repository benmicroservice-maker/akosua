# Akosua DESIGN — Native Overhaul Specification

**Date:** 18 October 2026 · **Status:** For owner approval (no app code until approved)
**Decisions locked:** Native VS Code workbench components (no React) · Agent chat as the
right-side (Secondary Sidebar) primary surface · Rollout = spec → branding → native chat ·
Engine professionalisation priority = **stack packs** for the owner's stacks.
**Companion docs:** `OWNERSHIP_AND_UI_REPORT.md` (research), `SPEC_BRAINSTORM.md` (product philosophy),
`PROGRESS_TRACKER.md` (phases).

---

## 1. Product principles (unchanged, now with a face)

1. **Understand → Research → Plan → Build → Verify.** Never code blind; never guess an API.
2. **Chat is the cockpit.** Everything the agent does is visible, beautiful, and reviewable
   *in the conversation* — the user should never need to dig through logs to trust the work.
3. **Evidence over claims.** Plans, diffs, test results and citations are first-class objects
   ("artifacts"), not prose buried in a stream.
4. **Native or nothing.** Akosua surfaces are built from VS Code's own components, Codicons and
   colour tokens, so the app reads as one designed product — identity through accent, behaviour
   and defaults, not alien styling.
5. **Professional in the owner's stacks.** NestJS+Fastify microservices (NATS JetStream/Kafka/
   RabbitMQ/Redis), Next.js, Flutter+Riverpod, TypeORM/Prisma, Python automations. Generic AI is
   table stakes; stack-correctness is the moat.

## 2. What we adopt from the best (research distilled)

| Source | Pattern we adopt |
|---|---|
| Cursor | Right-panel agent; inline diff bubbles per file with accept/reject; @-context pills in the composer; compact mode for long sessions; multi-file edits staged as one reviewable change-set |
| Antigravity | **Artifacts**: task list, implementation plan, walkthrough; tool calls grouped *within tasks*; verification evidence (test results, screenshots later) as deliverables; feedback on artifacts without stopping the agent |
| Agent-UI research (SetProduct et al.) | Live step ledger (pending ◯ / running ◌ / done ✓ / failed ✕); **tool-call cards** (name, input, truncated-expandable output, duration, status); reasoning collapsed by default; permission-tier badges on risky calls; diff-first run summary |
| Void | All fork AI code in ONE workbench folder (`contrib/akosua`), services + IPC to a privileged process; direct-to-provider (no cloud backend) — matches our approved architecture |

## 3. Information architecture

```
┌─Activity─┐ ┌─Primary─┐ ┌──────────── Editor ────────────┐ ┌── Secondary Sidebar (AKOSUA) ──┐
│ Explorer │ │ files/  │  code · native diff editor     │ │ Header: ● Akosua  [model ▾]   │
│ Search   │ │ search  │  inline change decorations     │ │ Phase stepper (5 phases)      │
│ SCM      │ │ ...     │                                │ │ Conversation (cards stream)   │
│ ▶ Akosua │ └─────────┘ └────────────────────────────────┘ │ Composer (input + @ chips)    │
│ Testing  │ ┌─Panel: Terminal · Problems · Akosua Runs───┐ └───────────────────────────────┘
│ Debug    │ │ verify output, checkpoint timeline, logs   │
└──────────┘ └─────────────────────────────────────────────┘
Status bar: ⟨phase⟩ · model per role · checkpoint state · stack badge (e.g. "NestJS · NATS")
```

- **Akosua view container** in the Activity Bar (own Codicon), opening the agent in the
  **Secondary Sidebar** by default (movable by the user — it's a real view, not a webview).
- **Views:** `Akosua Chat` (primary), `Akosua Runs` (panel: run history, verify output),
  `Checkpoints` (TreeView in SCM-adjacent container or inside Chat header overflow),
  `Project Brain` (TreeView: stack fingerprint, contract map, artifacts of the current project).
- **Commands:** `Akosua: New Conversation`, `Focus Chat` (Ctrl+Shift+L), `Approve Plan`,
  `Reject Plan`, `Undo Run (checkpoint)`, `Run Verification`, `Open Project Brain`,
  `Providers & Keys…`, all in the Command Palette and editor title where contextual.
- **Settings:** native Settings-editor section "Akosua" (providers per role, model IDs,
  MCP servers editor, personal rules, stack-pack toggles, autonomy/permission tiers).

## 4. The chat experience (the heart of this spec)

### 4.1 Message anatomy (top → bottom per agent turn)
1. **User bubble** — plain, right-accented minimal; @-chips rendered as file pills (click → open file).
2. **Phase stepper** — persistent sticky bar: `Understand → Research → Plan → Build → Verify`,
   each with state (waiting/active/done/blocked). This replaces the old inline arrows permanently.
3. **Step ledger** — the agent's current task list as live steps (Antigravity task-list artifact,
   inline): ◯ pending · spinner running · ✓ done · ✕ failed (failed expands with the error and
   what the agent will do next).
4. **Tool-call cards** — one card per tool invocation, grouped under their phase:
   - Header: Codicon + human verb ("Read file", "Edit", "Terminal", "Docs lookup", "MCP · github"),
     target (path/command/query), duration, status glyph.
   - Collapsed by default once done (except failures and edits); body shows input/output truncated
     with "Show more"; huge outputs paged, never flooding the stream.
   - **Permission badge** on Build-phase mutating calls; terminal commands show the exact command
     before/while running per autonomy setting.
5. **Thinking/reasoning** — collapsed "Reasoning" disclosure per step, one-line summary visible.
6. **Markdown answers** — full rendering: headings, lists, tables, code blocks with language
   highlighting + Copy / "Insert at cursor" actions; file references are clickable links.
7. **Citations** — research answers carry source chips (Context7 doc page, Firecrawl URL,
   YouTube timestamp) that open the source; idea-sources are badged `IDEA — verify before use`.

### 4.2 Signature cards (Akosua's own objects)
- **📋 Plan card (gate):** the implementation plan as a structured artifact — goal, files to
  touch, steps, risks, verify commands. Actions: **Approve & Build** / **Request changes**
  (comment box feeds back without restarting) / **Save plan only**. Nothing edits code before this.
- **✏️ Change-set card:** after Build — per-file rows (+12 −3), each opening VS Code's **native
  diff editor**; per-file **Keep / Revert**, global **Keep all / Undo run** (checkpoint).
  Inline diff bubbles (Cursor-style) optional in settings; change-set card is the source of truth.
- **🧐 Review card:** cross-vendor reviewer verdict (APPROVED / CHANGES REQUESTED) with findings
  list; CHANGES REQUESTED visibly loops the run back to Build (stepper re-activates).
- **✅ Verification card:** per-stack gate results — command, exit code, pass/fail/COULD-NOT-RUN
  (never a fake pass), expandable output; failed verification explains and offers "Fix & re-verify".
- **🔖 Checkpoint chip:** created pre-Build, always visible during Build/Verify; Undo = one click.
- **🧠 Brain card (Understand):** stack fingerprint summary ("NestJS 11 · Fastify · NATS JetStream ·
  Prisma — 14 services, 6 event contracts") with "Open Project Brain" — the user *sees* that
  Akosua understood their system before it planned anything.

### 4.3 Composer (input)
- Multi-line, grows upward; **Send** + **Stop** (while running) as native buttons.
- **Context chips row:** attached files/folders via `@` picker (files, folders, symbols, diff,
  terminal selection), shown as removable pills (Cursor pattern).
- **Model strip:** compact per-role indicators (Planner/Editor/Reviewer → provider+model);
  click → native settings. Wrong/missing model = inline, actionable hint in the strip (replaces
  today's dead-end error message).
- Queue follow-up while running (message queues with visible pending state); input history (↑/↓).

### 4.4 Conversation management
- Multiple conversations (tabs or picker in the Chat view header), persisted per workspace;
  rename, delete, export transcript (Markdown); **artifacts persisted** to `.akosua/artifacts/`
  (git-ignored): `plan.md`, `research.md`, `walkthrough.md` per run — Antigravity-style evidence
  the user can re-open, diff, and share.
- Empty state: branded welcome with stack-aware starter actions ("Explain this codebase",
  "Add a NestJS endpoint", "Fix the failing test") — not a blank box.

### 4.5 Feel & performance rules
- Streaming text without layout jank; cards animate state only (VS Code motion tokens); the view
  survives 2,000-line tool outputs and 100+-card runs (virtualised/paged rendering, collapsed
  history); keyboard-first (focus composer with Ctrl+Shift+L, Esc returns to editor);
  full theme fidelity (light/dark/high-contrast via tokens), ≥12px secondary text, no emoji as
  functional icons (Codicons only), screen-reader labels on cards.

## 5. Visual identity (L3 shell takeover)

- **Akosua icon set** (app, activity bar, installer, welcome) — one mark, one accent colour
  (to be proposed in UI-1 with 2–3 options for owner pick); accent flows to phase stepper,
  primary buttons in Akosua views, status bar agent state.
- **Names fixed everywhere:** installer `AkosuaSetup-x64-<ver>.exe`, About, window title,
  welcome page ("Welcome to Akosua" with Get Started: add keys → pick models → open project).
- **Defaults that say "our app":** Akosua view visible on first run, secondary sidebar open on
  first launch with the welcome conversation, sensible default keybindings, telemetry stays
  Code-OSS-clean. Everything else remains familiar VS Code — intentionally.
- Fresh GUIDs for installer/AppUserModelId before any "release" build.

## 6. Native architecture (how we build it, merge-safe)

```
vscode-src/src/vs/workbench/contrib/akosua/
  browser/   chat view, cards, composer, plan/diff/review/verify views, brain tree,
             checkpoints tree, welcome, status bar, commands, decorations
  common/    shared types: agent events, card models, artifact models, stack-pack ids
  electron-main/ (or shared-process service)  agent host: runs @akosua/core logic
             (fs/git/terminal/MCP/providers/research), secrets via ISecretStorageService
```
- **Engine reuse, not rewrite:** `@akosua/core` (37 tests green) is consumed by the agent-host
  process; the workbench subscribes to its event stream (phase/text/tool/review/done) — the same
  events the webview consumed, now rendered natively. Providers/keys stay in SecretStorage.
- **IPC:** a single `akosua-agent` channel (Void-style channel pattern), streaming events,
  cancellation, checkpoint ops.
- **Migration:** new native Chat ships *behind* the extension (extension hidden by default once
  native reaches parity on: run lifecycle, plan gate, change-set/undo, verify card, MCP notices).
  Extension then removed; core stays.
- **Upstream safety:** all fork deltas confined to `contrib/akosua/` + product.json/rebrand +
  minimal registrations list (documented patch inventory in the repo root, `FORK_PATCHES.md`),
  so monthly upstream merges touch near-zero shared files.
- **Settings/schema:** contributed via the native configuration registry (same keys as today:
  `akosua.*` — users keep their settings across the migration).

## 7. Engine professionalisation — Stack Packs (priority track)

A **stack pack** = fingerprint detectors + contract extractors + research routing + verify gates
+ prompt rules, shipped per stack, visible in the Brain view:

| Pack | Detects | Contracts/understanding | Verify gates | Research bias |
|---|---|---|---|---|
| **NestJS Microservices** | Nest/Fastify vs Express, transport (NATS JetStream/Kafka/RabbitMQ/Redis), TypeORM/Prisma | controllers/DTOs, event topics→producers/consumers, module graph, gateway→service map | `nest build`, unit+e2e, per-service typecheck | Context7: NestJS/transport docs version-pinned first |
| **Next.js** | app/pages router, RSC boundaries, route handlers | routes→handlers→services, server actions, env usage | `next build`, typecheck, lint | Next.js docs for exact version |
| **Flutter/Riverpod** | pubspec, Riverpod codegen, go_router | providers→screens graph, freezed models | `flutter analyze`, `flutter test` | pub.dev + Flutter docs |
| **Data (Prisma/TypeORM)** | schemas, migrations | entity→DTO→API drift warnings | prisma validate/generate, typeorm checks | ORM docs |
| **Python automations** | pyproject/venv, FastAPI/scripts | entrypoints, schedulers | pytest, ruff, mypy (when configured) | PyPI + docs |

Engine rules enforced in UI: Brain card shows the detected pack(s) before planning; Plan card must
name affected contracts (endpoints/events) when a change crosses them; Verify card runs the pack's
gates in order and reports COULD-NOT-RUN honestly. Research hierarchy stays: code/tests >
lockfiles > Context7 (version-pinned) > Firecrawl > YouTube/community (IDEA badge).

## 8. Rollout (each step = one or more CI installer cycles, user-tested)

| Phase | Delivers | Acceptance (owner-visible) |
|---|---|---|
| **UI-0** | This spec approved | You say "build it" |
| **UI-1 Identity** | Icons (owner picks), installer name, welcome, defaults, GUIDs | Fresh install *looks* like Akosua, not VS Code |
| **UI-2 Native chat** | `contrib/akosua` chat: stepper, streaming, tool cards, composer w/ model strip, conversation persistence | A full run in native chat ≥ today's extension in function, visibly native in feel |
| **UI-3 Gates & evidence** | Plan card gate, change-set + native diff review, review & verify cards, checkpoint view, artifacts on disk | Approve→build→review→verify→undo entirely in native UI |
| **UI-4 Brain & stacks UI** | Project Brain view, stack badges, pack-aware plan/verify presentation | Brain card correct on your real monorepo |
| **UI-5 Engine packs** | Stack packs v1 (NestJS, Next, Flutter, Data) behind the UI | Pack gates catch a deliberately broken change in test projects |
| **UI-6 Retire extension** | Webview removed; settings untouched | Same settings/keys; app is fork-native end to end |

## 9. Risks & mitigations
- **Upstream merge tax (forever):** contrib isolation + patch inventory + CI smoke on each sync.
- **Native DOM components are verbose:** component mini-library inside `contrib/akosua/browser/ui/`
  (buttons, cards, disclosures) written once, reused everywhere.
- **Long-run rendering perf:** card virtualisation rules in §4.5 are acceptance-tested in UI-2.
- **Scope creep toward L4 (tab model, parallel agents):** explicitly parked; single-agent excellence first.

## 10. Explicitly out of scope (for now)
Custom autocomplete/tab model, parallel sub-agents & agent-manager window, browser-control agent,
cloud backend/sync, mobile. (Revisit after UI-6 with the same research-first process.)
