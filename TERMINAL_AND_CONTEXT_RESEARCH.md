# Terminal control + context engineering — research notes (2026-10-18)

## Terminal control (what good harnesses do)
- Foreground commands run with a timeout; long-runners are promoted to
  BACKGROUND jobs with stable IDs instead of blocking the loop
  (Claude Code Ctrl+B / run_in_background; OpenDev six-stage shell).
- Job API: start / poll (status) / log (tail output) / wait (block with
  timeout) / kill (whole process group/tree) / list / send-input
  (VS Code 1.115-1.116 `send_to_terminal` + `get_terminal_output`).
- Output is file/ring-buffer backed, capped (OpenDev 30k head+tail);
  the agent pages it, never re-runs to "check".
- Dev-server patterns (dev/serve/start/watch) are detected and the
  agent is steered to background mode.
- Known failure modes to avoid: jobs orphaned on session exit, stale
  "running" bookkeeping, killing only the shell but not children.
  => Akosua: in-memory job manager, process-tree kill
  (taskkill /T on Windows, process-group SIGTERM elsewhere), jobs are
  killed on bundle close, status is derived from the real child exit.

## Context engineering (Anthropic Write/Select/Compress/Isolate)
- Cap tool outputs FIRST: trivial output capping alone cut cost/turn
  ~38% in controlled runs; compaction (LLM summarise) is the fallback,
  not the first move.
- Staged pressure response: ~70% warn/favour JIT retrieval, ~80%
  mask old observations to digests, ~90% prune hard; always reserve
  headroom — budget the WORKING context to ~75% of the rated window.
- Preserve decisions (user/assistant text), compress bulk evidence
  (tool results); keep the most recent tool results verbatim.
- Externalize: durable state lives in files (notes, checkpoints, git),
  not in the window. Isolate: sub-agents burn their own windows and
  return digests (Akosua delegate_research already does this).
- Never compact tiny/short histories (overhead > benefit).

## Akosua implementation (this batch)
- `terminal_jobs` tool + `BackgroundJobManager` (start/poll/log/wait/
  kill/list/send), server-pattern steering, tree kill, 200KB tail cap.
- `terminal` gains `timeoutMs`; timeouts no longer poison the session
  (shell is restarted cleanly).
- Context v2: per-tool output caps (`shapeToolResultFor`), staged
  compaction with pressure levels + a visible compaction notice,
  tighter compaction at phase boundaries, file-view line cap.
- Prompt rules: delegate broad research, background long-runners,
  view files in ranges — the model is told the hygiene rules the
  harness enforces mechanically anyway.
