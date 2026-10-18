# Akosua — Goal Audit (2026-10-18, core 0.7.0)

Question from the owner: *"Verify the goal I gave you at the beginning of this
chat will be achieved with Akosua."* This audit re-read the original spec
(SPEC_BRAINSTORM.md, all 5 rounds) and checked every promise against the
actual code — not the tracker. Six real defects were found and fixed during
the audit (below). The verdict is at the end; it is not unconditional.

## The original goal, distilled
A personal (not-for-sale) Cursor-killer IDE on a Code-OSS fork, for
NestJS/Fastify microservices (NATS/Kafka/RabbitMQ/Redis), Next.js,
Flutter+Riverpod, TypeORM/Prisma, Python — where the AI (1) fully understands
the codebase before editing, (2) researches live docs instead of trusting
stale training knowledge, (3) follows Understand→Research→Plan→Build→Verify
always, (4) never guesses, (5) uses Claude+OpenAI interchangeably with
cross-vendor review, (6) is safe (checkpoints, diff review, undo), and
(7) supports external MCP servers while Context7/Firecrawl/YouTube are native.

## Promise-by-promise (evidence in code)
| Promise | Status | Evidence |
|---|---|---|
| 5-phase enforced workflow | ✅ | `src/agent/loop.ts` sign-off state machine; tools phase-gated in `tools.ts`; budgets/nudges/repeat-guard from live testing |
| No edits before Understand+Research | ✅ after fix | file_editor mutations gated; **terminal was NOT (fixed, see D2)** |
| Never guess / honest verification | ✅ after fix | Verify gate rejects sign-off without `run_verification`; **empty checks falsely PASSED (fixed, D1)**; prompt rule 6 PASS/FAIL/COULD-NOT-RUN |
| Full codebase understanding | ⚠️ strong v1 | Fingerprint (nested monorepo scan), Project Brain, regex structural index, contract map (routes/DTOs/Prisma/consumers/events), hash semantic search. **Not** tree-sitter/LSP (planned upgrade); event extraction is decorator-based only (client `emit()` call sites not yet mapped) |
| Live docs before coding | ✅ | Context7 (primary, version param), Firecrawl, YouTube (ideas-only), package_lookup — all live-verified 2026-10-18. Caveat: the agent must read the lockfile version itself; fingerprint doesn't auto-inject dep versions into Brain yet |
| Claude+OpenAI, per-phase routing | ✅ | Providers stream both; Planner/Editor/Reviewer routing unit-proven; only when model ids are set (never guessed) |
| Cross-vendor review | ✅ | Reviewer (no tools) judges the real git diff at Build→Verify; CHANGES REQUESTED loops back ≤2 rounds; outage disclosed. Only active when reviewerModel set — handover instructs setting it |
| Checkpoints / diff / Undo | ✅ | Temp-index checkpoints (branch/index untouched), 1 per session, panel diff-stat + Undo (git-tested) |
| Keys safe | ✅ | SecretStorage (Windows Credential Manager); Settings→Providers & Keys with Test Connection; keys never in files/settings |
| MCP external servers | ✅ after fix | Core MCP client existed; **the IDE never passed servers (fixed, D4)** — now `akosua.mcpServers` setting, namespaced, Build-blocked by default |
| Persistent rules (anti-forgetting) | ✅ after fix | `AKOSUA_RULES.md` + `akosua.personalRules` injected every run (D5) |
| Stacks: Nest/Fastify/transports, Next, Flutter/Riverpod, Prisma/TypeORM, Python | ✅ detection-level | Fingerprint + extractors + per-stack verify commands; **nested monorepo manifests were missed (fixed, D3)**. TypeORM entity *relations* not specially extracted (classes/DTOs are) |
| Windows IDE | ⏳ unproven | Everything is scripted (pinned 1.143.0, rebrand, handover pack) but **has never compiled anywhere** — Stage 2 baseline on the owner's workstation is the first real proof |
| Speed (Zed-envy) | ⏳ by design | Code-OSS/Electron shell (accepted in spec); Rust sidecar only if profiling demands; research cache + incremental index done; parallel sub-agents NOT implemented |
| Cursor feature parity (Tab autocomplete, inline edit) | ❌ not built | Akosua inherits VS Code IntelliSense + Open VSX extensions, but has **no AI inline completion** of its own. The spec's bet was agent quality over autocomplete; know this going in |
| Spec's extra native tools (browser/Playwright verify, DB inspector, Docker logs, GitHub tool) | ❌ not built | Terminal + git cover part of this ad hoc; the named tools don't exist yet |

## Defects found in this audit and fixed (core 0.6.0 → 0.7.0, 31→36 tests)
- **D1** Verification with zero detected commands reported **PASSED** (empty
  `every`). Now COULD-NOT-RUN / correctness UNKNOWN everywhere.
- **D2** Terminal tool ran in **Understand**, letting the agent mutate files
  via shell before any sign-off — a hole straight through the phase gate.
  Now Build/Verify only.
- **D3** Fingerprinter read only root manifests: on the real sample monorepo
  it **missed Flutter (apps/mobile)** and targeted no `flutter analyze`.
  Now scans manifests to depth 3, merges deps, per-package verify commands,
  `flutter analyze apps/mobile`.
- **D4** MCP client existed in core but the extension never wired settings —
  external MCP servers were unreachable from the IDE. Now an
  `akosua.mcpServers` setting with a unit-tested parser that reports (never
  silently drops) malformed entries.
- **D5** "Forgetting instructions" had no mechanism: prompt was hard-coded.
  Now `AKOSUA_RULES.md` (project) + personal rules (global) are injected
  into every run.
- **D6** file_editor path check used naive prefix matching — `../ws-evil`
  escaped a workspace at `.../ws`. Now separator-aware containment.
- Also: extension `npm test` never recompiled its tests (stale output) —
  script fixed; extension now 3/3 honestly.

All fixes regression-tested: **core 36/36, extension 3/3**, extension compiles.

## Verdict
**The CORE goal will be achieved** — an agent that understands first,
researches live, plans, builds surgically, gets cross-examined by a rival
model on the real diff, and may not claim success without executed evidence,
on your exact stacks, with your keys in the OS vault and one-click undo.
That machinery exists, is unit-tested, and has already run end-to-end against
live models and live research APIs.

**Three honest conditions/caveats:**
1. **Unproven until your PC runs it.** The fork has never compiled. If Stage 2
   (unmodified baseline) fails, it's environment; if Stage 5 fails, it's ours
   — either way it's fixable, but "IDE" is a promise only your workstation
   can cash.
2. **It is not yet Cursor.** No AI autocomplete/inline-edit, no browser/DB
   tools, regex (not tree-sitter) understanding, hash (not neural) semantic
   search, no parallel sub-agents. It beats Cursor on *discipline*; Cursor
   still wins on *surface breadth* until those land.
3. **Depth comes from dogfooding.** The contract map, fingerprints and verify
   gates were proven on a synthetic monorepo. Your real repos (messier
   decorators, Nx/Turborepo variants, real TypeORM relations) will find the
   next ten defects. That loop — not more sandbox code — is what closes the
   last gap.

Recommendation: run the Windows pack, walk the dogfooding checklist, and let
the failures on YOUR code dictate the next build round.
