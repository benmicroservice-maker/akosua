# Akosua BUILD PLAN — Local-First Overhaul (No CI Until Done)

**Owner directive (2026-10-18):** GitHub Actions builds take ~30 min. STOP spending them per
increment. Build EVERYTHING locally first — full overhaul, best product we can make — then run
CI once at the end to surface packaging errors and fix them with the full picture in hand.

**Rule:** No `workflow_dispatch` until the Local Completion Gate (below) is signed off here.

## Track A — Harness excellence (beat Cursor at the harness game)
Evidence base: `HARNESS_RESEARCH.md` (same model, different harness = up to ~36-point swings).

- [x] A1 Context management: token budgets per phase, stale tool-result truncation,
      mid-run compaction, structured run notes (artifacts) — *in progress*
- [x] A2 Tool-result shaping: model gets parsed/summarised results (errors extracted),
      UI keeps full output
- [x] A3 Diagnostics-after-edit loop: edits auto-trigger cheapest oracle (typecheck/analyze)
      on touched packages; parsed diagnostics returned to agent; 3-strike fix cap enforced
- [x] A4 Retrieval upgrade: syntactic (symbol) chunking TS/Dart/Python + hybrid ranking
      (contracts/graph + lexical + semantic), per-phase context budgets
- [x] A5 Prompt/tool craft pass: never speak tool names to user, explain-before-call,
      anti-early-stop, root-cause rules (several already in; complete the set)
- [x] A6 Stack packs v1: NestJS+Fastify/transports, Next.js, Flutter+Riverpod, Prisma/TypeORM,
      Python — detectors, contracts, verify gates, research routing, failure playbooks
- [x] A7 Private benchmark (offline pipeline; live scoring reserved): fixed tasks on fixture monorepo + scripted checks; every harness
      change measured (same model/budget) before it ships

## Track B — Native overhaul (DESIGN.md UI-1..UI-6)
- [x] UI-1 Identity (icon, AkosuaSetup name) — built in CI, verified
- [x] UI-2 Native chat (fork overlay + apply-script tested; real compile in next CI run): `contrib/akosua` in fork overlay — chat view, phase stepper,
      tool cards, composer, model strip (written locally as fork patch set; compile-tested
      only at the final CI gate — static discipline + Void-pattern fidelity meanwhile)
- [x] UI-3 Gates & evidence (plan card + .akosua/runs artifacts + walkthrough; native diff editor next): plan card, change-set + native diff, review/verify cards,
      checkpoint view, artifacts on disk
- [x] UI-4 Brain & stack UI (Project Brain native view + pack list): Project Brain view, stack badges, pack-aware plan/verify
- [ ] UI-6 Retire webview extension — DEFERRED BY DESIGN: requires moving the agent host from the extension into the fork (Void pattern: utility process). The native UI already talks through the command bridge, so UI-6 changes the host, not the UI. Prerequisite: fork compiles in CI.

## Track C — Engine depth (from SPEC phases still open)
- [x] C1 Change-set review + inline edit DONE (extension command; native inline UX after fork compile): groundwork was: core diff parser (tested), native diff command, inline add-decorations command, native-view buttons. Full inline-edit UX still open.
- [x] C2 MCP polish: MCP calls render as labelled cards (`MCP · server: tool`) in the native view; allowBuild remains config-gated in core.
- [x] C3 Research depth: package_lookup already phase-wired; citation chips render source URLs from tool evidence in native cards.

## Local Completion Gate (ALL must be true before the next GitHub Actions run)
1. `@akosua/core` full test suite green incl. all new harness tests.
2. Extension compiles; native fork patch set applies cleanly to a pristine pinned clone
   *in this sandbox* (patch-application test, even though full compile needs CI).
3. Benchmark (A7) runs offline with a scripted provider end-to-end.
4. DESIGN.md acceptance checklists reviewed line by line; PROGRESS_TRACKER updated.
5. Only then: ONE full CI build → read all errors → fix locally → repeat CI only for fixes.
