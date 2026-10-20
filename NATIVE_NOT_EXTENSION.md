# Native, not an extension — architecture verdict (2026-10-18)

## The question
"Is Akosua weak because we built it as an extension instead of a
native tool like Cursor?"

## Short answer
Half right. Cursor is a VS Code **fork**: "we forked VS Code instead
of building an extension so we could shape our own surface" (Cursor
team, Cursor 3 post). A fork controls the whole chrome — chat panel,
diff UI, agent switching, terminals — while an extension is a guest
in a sandbox with only the published API.

Akosua is ALREADY a fork: the chat, composer, stepper, cards and
Project Brain are native workbench code (`fork/contrib/akosua`,
registered views in the Secondary Sidebar, workbench commands,
Ctrl+L). What still lives in an extension is the **agent host** (the
process that runs @akosua/core: model calls, tools, terminals,
checkpoints). It was bundled as an extension for one practical
reason: the workbench (browser/Electron renderer) cannot spawn
processes, read files or run git — that work needs a Node process,
and the extension host is VS Code's sanctioned Node process.

## What the hybrid costs us (the gaps the user felt)
1. Two worlds bridged by commands (`akosua.agent.send` /
   `akosua.native.event`): any dropped field (durationMs, action)
   silently degrades the UI — exactly the fake-timing bug.
2. Extension-host lifecycle: activation timing, "host may still be
   starting" errors, background jobs tied to host lifetime.
3. No direct access to workbench services from the agent: editor
   opening, inline diff decorations, progress and terminal services
   all cross the API boundary (each must be wired by hand — the
   unwired ones read as "broken buttons").
4. Settings split between workbench config and extension code.

## What the hybrid does NOT cost us
Model quality, harness logic, retrieval, context engineering and
terminal control all live in @akosua/core, which is process-agnostic
TypeScript. Moving the host changes plumbing, not capability. The
terminal/context work in this batch proves the point: the harness
grew background jobs and staged compaction without any native code.

## The end-state (Cursor-shaped)
- Native workbench UI (done, being polished this batch).
- A first-party **agent host process owned by the fork**: VS Code's
  own Copilot terminal tools were migrated from extension into core
  in 1.103 for exactly these reasons ("access to lower-level and
  richer APIs… no longer restricted to the extension API").
  Akosua's equivalent: register the agent as a workbench service
  backed by a dedicated Node utility process (the pattern VS Code
  uses for its shared/utility processes), speaking the same
  AgentEvent stream — the UI contract does not change.
- Product-level defaults (layout, sidebar placement, keybindings)
  set in product.json/configurationDefaults, not user settings.

## Migration plan (staged, no big-bang)
- N1 (this batch): close every visible gap inside the current
  architecture — rich text, working indicator, Undo, Review that
  survives run end, editor opening, Brain separated + progress,
  feedback on every action. If a button exists, it visibly works.
- N2: move Brain + chat placement fully native (Brain gets its own
  Primary-Sidebar container; chat owns the Secondary Sidebar).
- N3: fork-side agent service skeleton in `contrib/akosua`:
  `IAkosuaAgentService` + event contract mirroring AgentEvent, host
  still backed by the extension during transition (adapter), so UI
  work is never blocked on process plumbing.
- N4: utility-process agent host inside the fork; extension shrinks
  to nothing and is removed from the product build. Core unchanged.
- N5: product.json defaults (secondary sidebar visible, Akosua
  layout), first-run experience owned by the fork.

Each stage ships independently; N4 is the only one that can break
the installer, so it comes last and gets its own build cycle.
