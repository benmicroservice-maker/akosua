# Akosua Diagnostics — how your runs teach the developers

Akosua now ships a **Flight Recorder**. The developers cannot run the IDE on
your machine, so the recorder is their eyes: it writes down everything the
harness does while you work, and you hand that record back.

## What gets recorded (automatically, always on)

Into `<your project>/.akosua/diagnostics/session-*.jsonl`:

- Every run: your task, which models were used, the **full system prompt**
  the model was given, and which tools it was offered in each phase
- Every model turn: latency + time-to-first-token, **token usage**
  (in/out/cached, as the provider reports it), why the model stopped,
  the actual model that answered, what it replied, and which tools it
  called **with the actual arguments**
- Every tool result (up to 20,000 chars), its duration, and a pass/fail flag
- Phase changes, the plan-approval and verify **gates**, provider retries,
  context compactions, reviewer verdicts (with timing), **sub-agent**
  internals (their own turns and tool calls, not just the digest),
  change-sets, errors, notices shown to you
- Host actions: activation, Brain rebuilds (with duration), connection
  tests, cancellations, your annotations
- The report auto-flags suspicious patterns: the same tool called with
  identical arguments 3+ times (a stuck loop), the slowest tool calls,
  failed tools, and runs that ended without a clean finish

**Never recorded:** API keys or tokens. Redaction is automatic (by field
name and by value shape — `sk-…`, `github_pat_…`, `Bearer …` are scrubbed
before anything touches disk). Recording is bounded (10 MB per file, then
it rotates) and can be turned off with `akosua.diagnostics.enabled=false`.

## The workflow

1. **Use Akosua normally** on a real project.
2. **When something feels wrong** — wrong file edited, reply made no sense,
   it got stuck — click the **flag icon** in the chat header ("Mark issue in
   flight log") and type one line about what happened. That pins your note
   into the timeline at exactly that moment. (Command Palette also works:
   `Akosua: Mark Issue in Flight Log`.)
3. **When you're done**, click the **pulse icon** in the chat header
   ("Export diagnostics bundle") — or Command Palette →
   `Akosua: Export Diagnostics Bundle (share with developers)`.
4. **Share it back, two layers:**
   - **Paste the `.md` report** (`.akosua/diagnostics/akosua-diagnostics-<date>.md`)
     straight into the chat — it stands alone for most problems: runs,
     tokens, models, tools, loops, gates, errors, your annotations.
   - **Attach the `.json` bundle** of the same name when the developers
     need the full turn-by-turn record (every prompt, argument and
     result). It stays attachable: the newest ~12 MB of events are kept
     and any trimming is declared in the file itself.

That's it. With that file, the developers can reconstruct the run
turn-by-turn — what the model saw, decided, and did — and fix the harness
against evidence instead of guesses.
