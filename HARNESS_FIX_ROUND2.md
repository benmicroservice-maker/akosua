# HARNESS FIX ROUND 2 — from live screenshots 2026-10-20 (user's first test of the rebuild)

Evidence: "start the app" NEVER ran a terminal command. It burned 3.6s on Context7
Expo docs, wrote notebook notes x3, hit the git-checkpoint error, and died at
(phase: plan) after 40s. Root causes found in code (not guessed):

1. Plan gate (loop.ts) applies to execute-kind runs: `requirePlanApproval &&
   phase==="plan"` has no actKind exemption -> run ends awaiting approval of a
   plan that changes zero files. Each follow-up message restarted at Understand.
2. Research phase is only *advised* to skip for execute; context7_docs is even
   offered in Understand. Model did docs ceremony instead of running.
3. Verify gate counts ONLY run_verification; for "start the app", verification
   is the server's own output (terminal/terminal_jobs) — would have blocked next.
4. Loop yields tool events WITHOUT `action`; extension + fork UI read
   ev.action to label Read vs Edit — so every read rendered as "Edit file".
5. "get context awareness of this project" classified act (imperative "get")
   -> full ceremony for what is a read-only overview question.
6. Fork "Run finished" footer always says "Review the change-set, Keep/Undo"
   even for read-only runs with no changes.

## Fixes (deterministic, harness-level — not prompt wishes)
- [x] Execute-kind: plan gate skipped entirely (flight-recorded as skipped)
- [x] Execute-kind: Research phase skipped in sign-off advancement +
      research tools (context7/firecrawl/youtube/package/delegate_research)
      never offered in any phase
- [x] Execute-kind: terminal/terminal_jobs output in Verify counts as
      verification evidence for the verify gate
- [x] Tool events carry `action` (file_editor command) end-to-end
- [x] Intent: context-awareness/overview/walkthrough requests -> ask lane
- [x] Fork footer: change-set sentence only when run reached Verify

## Acceptance (scripted, hard)
- [x] EVAL: "start the app" with requirePlanApproval=true reaches terminal
      in Build, completes Verify from terminal evidence, never offers
      context7, <=6 model calls, no user approval needed
- [x] EVAL: reads surface action="view" on tool events
- [x] Classifier pins: awareness->ask, "start the app"->act/execute
- [x] Full gates: core + typecheck + extension; ship via CI; user re-tests
