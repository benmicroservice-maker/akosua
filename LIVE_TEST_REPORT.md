# Akosua — First Live-Model Test Report (2026-10-18)

Setup: real OpenAI key (user-provided for testing, in-memory only, never written to a file),
model `gpt-4.1` Planner via @akosua/core OpenAI provider, on a COPY of
test-projects/sample-monorepo (/tmp/akosua-live-test, git-initialised).
Task: OrdersService.getById(id) -> { id, total: 0, status: 'PENDING' } + GET /orders/:id in
OrdersController via @Get(':id')/@Param. Instruction included: report verification honestly
(deps not installed in the copy), do not npm install.

## Attempts
1. **FAIL (agent loop)**: Agent understood well + used Context7 in Understand, but emitted
   UNDERSTANDING+RESEARCH+PLAN sign-offs in ONE message; the loop honoured only the first,
   then it looped 60 mostly low-value search_code calls in Research and ended. No files changed.
   Fixes: multi-signoff advancement, per-phase tool budget (20) with forced summary turn,
   identical-call repeat guard, search_code removed from Research, file_editor arg validation.
2. **FAIL (sign-off format)**: Agent wrote "PLAN APPROVED." (period); detector required ":".
   Fix: punctuation-tolerant hasSignoff(). (First patch attempt also broke a regex via
   escaping — caught by the TS build, fixed.)
3. **FAIL (tool ergonomics)**: Model passed 0-indexed view_range; viewer returned an empty
   last line, so it retried views and claimed sources "couldn't be loaded". Fix: clamp
   view_range to 1-based lines. Also: a message repeating an earlier phase's marker killed
   the run. Fix: sign-off nudge (max 3) instead of silent termination.
4. **PASS**: All 5 phases completed in order (30 tool calls, ~40s). Unit suite 21/21 incl.
   a multi-signoff regression test.

## Final live result (attempt 4)
- Controller: imports Param, adds `@Get(':id') getById(@Param('id') id: string)` ->
  `orders.getById(Number(id))`, AND renamed the pre-existing message handler to
  `getByIdMessage` to avoid a duplicate method name (unprompted, correct).
- Service: `getById(id: number) { return { id, total: 0, status: 'PENDING' }; }` exactly as specified.
- Agent created git checkpoints before edits (7 checkpoint refs — works, slightly eager).
- Verify: run_verification correctly FAILED (tsc/eslint/jest not installed, exit 127) and
  the agent reported exactly that with output, explicitly NOT claiming build/lint/test success.
  Minor overreach in prose: "No project logic errors were detected" (it cannot know that
  without a typecheck) — noted as a prompt-hardening item, not a code failure.

## Known issues spotted
- Agent checkpoints before nearly every edit (consolidate to one per Build session).
- Workspace gains an untracked `.akosua/` folder (research cache) — Akosua should ensure
  `.akosua/` is in the project's .gitignore, or keep state outside the repo tree.
- Sign-off prose quality varies by run; loop guardrails (budget/nudge/repeat-guard) are
  what make completion reliable across that variance. This validates the core design
  decision: discipline enforced by the harness, not hoped for from the model.

## Security
Key used only via process env in the test runner; not stored in any workspace file.
User advised to revoke the chat-pasted OpenAI key now and issue a fresh one for future
live tests / the real Settings screen.
