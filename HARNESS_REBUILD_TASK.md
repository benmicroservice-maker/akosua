# HARNESS REBUILD — task list (started 2026-10-20, user directive: "get it right")

Goal: a harness the user can trust — right-sized ceremony per request, oriented
from turn 0, honest capability claims, and a flight recorder detailed enough
that a pasted bundle fully reconstructs any run for remote diagnosis.

## Slice 1 — routing + orientation (DONE, core 128/128)
- [x] Intent lanes chat/ask/act (intent.ts) + AgentConfig.lane override
- [x] Chat = 1 call/no tools; Ask = read-only, first answer ends; Act = ceremony
- [x] Brain brief in system prompt; language census; Flutter/Dart fixes
- [x] Per-turn phase-capability brief (request-only, never history)

## Slice 2 — ACT lane slimming (this build)
- [x] intent: act sub-kind execute (run/start/test/install…) vs change (edit/fix…)
- [x] execute-kind: tight Understand/Research tool budget (6) before forced sign-off
- [x] execute-kind phase brief: reach Build fast, read manifest/scripts only
- [x] plan gate unchanged for change-kind (human approval stays a feature)

## Slice 3 — ranked repo map (Aider pattern, this build)
- [x] rank files by import-graph centrality (in-degree) + entry-point bonus
- [x] Brain file map ordered by rank (not alphabetical), top symbols kept
- [x] brainBrief gains "Key files" (top 8) so turn 0 knows where the weight is

## Slice 4 — Flight Recorder v4 (this build)
- [x] loop: sign-off nudges + budget exhaustion recorded as events
- [x] summary: per-run lane, turns, tool vs text-only turns, nudges, gates
- [x] report: "Harness health" section (lane mix, ceremony ratio, avg turns/run)
- [x] duplicate consecutive errors collapsed (live bundle showed each error twice)
- [x] recorder self-stats (written/writeErrors/rotations) in report header

## Slice 5 — harness evals (this build)
- [x] scenario suite w/ scripted providers + HARD budgets (calls/turns/tools):
      chat=1 call; ask<=3 turns & no write tools offered; create-file act run
      reaches the edit in <=4 turns; execute-kind brief present; brain brief
      present in assembled prompt; Flutter fixture brief says Dart
- [x] eval failures fail CI-local tests (they ARE tests, not vibes)

## Slice 6 — ship
- [x] core + extension gates green; tracker updated
- [x] push main, dispatch Windows CI, verify artifact, hand user test script:
      1) "how are you" (expect instant, no cards) 2) "what does X do?"
      3) Flutter project Brain check 4) "start this app" 5) paste diagnostics
