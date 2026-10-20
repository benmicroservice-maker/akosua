# Akosua — Harness Research: Why the Same Model Performs Better in Cursor

**Date:** 18 October 2026 · **Commissioned by:** Owner directive — "Cursor doesn't provide the AI,
they build the software that makes the AI work well… we want to know how they do this and
even do better than them." · **Status:** Research feeding UI-5+/engine program. No speculative
claims: public sources + our own codebase audit only.

---

## 1. The thesis, with evidence

**Agent = Model + Harness.** The harness — prompts, tools, context construction, loop control,
error recovery, verification — is the product. The model is rented.

Measured proof that this is real, not marketing:

- On SWE-bench Pro with the **same** Claude Opus 4.5: ~45.9% under a standardized minimal
  scaffold, ~50.2% under Cursor's harness, ~55.4% under Claude Code's — a ~9.5-point spread
  with zero model change ([FutureAGI harness benchmark](https://futureagi.com/blog/coding-agent-harness-benchmark),
  [Particula analysis](https://particula.tech/blog/agent-scaffolding-beats-model-upgrades-swe-bench)).
- Across frontier models on SWE-bench Verified, models differ by ~0.8 points while scaffolding
  changes swing 22+ points ([Particula](https://particula.tech/blog/agent-scaffolding-beats-model-upgrades-swe-bench)).
- A position paper formalises it (the *Binding Constraint Thesis*): for long-horizon tasks,
  "the agent execution harness… is often a stronger determinant of agent performance than the
  model it wraps" ([arXiv 2605.23950](https://arxiv.org/html/2605.23950v1)).
- One mechanical harness change — shortening stale tool results + stall detection — raised
  complete solutions from 43 → 72 on a 169-task SWE-bench Verified cohort, same model
  ([arXiv 2608.26218](https://arxiv.org/html/2608.26218)).
- Leaner is often better: heavy harnesses front-load context every turn; a tight harness sent
  ~3× less context per turn at equal quality in Databricks' comparison
  ([Rohit Ghumare](https://rohitghumare.com/blog/coding-agent-harnesses/)).

**Conclusion for Akosua:** chasing the newest model is the weakest lever we have. The wins are in
context, tools, loop discipline, edit mechanics and verification — most of which we can build
*better than Cursor for one developer's stacks*, because Cursor must be general and we don't.

## 2. How Cursor's harness actually works (public record)

### 2.1 Context engine (their deepest moat)
- **Merkle-tree sync:** a hash of every file/folder detects exactly what changed; only changed
  files are re-processed ([Cursor: Securely indexing large codebases](https://cursor.com/blog/secure-codebase-indexing)).
- **Syntactic chunking:** files are split with tree-sitter at function/class boundaries, not by
  line/token counts, so retrieved units are coherent ([Towards Data Science](https://towardsdatascience.com/how-cursor-actually-indexes-your-codebase/),
  [Bito guide](https://stg.bito.ai/blog/how-cursors-codebase-indexing-works-2026-guide/)).
- **Own embedding model trained on agent traces:** retrieval optimises for "which chunk actually
  helped the agent on past tasks", not text similarity ([Manthan Gupta analysis](https://manthanguptaa.in/posts/how_cursor_index_your_codebase/)).
- **Two indexes:** semantic (vector, server) **plus** a local trigram/sparse-n-gram regex index —
  fresh to the keystroke, because stale regex results send agents spiralling
  ([Manthan Gupta](https://manthanguptaa.in/posts/how_cursor_index_your_codebase/)).
- **Embeddings cached by chunk hash**; unchanged code never re-embedded; teammate index reuse via
  simhash cuts time-to-first-query from hours to seconds on giant repos
  ([Cursor blog](https://cursor.com/blog/secure-codebase-indexing)).
- **Context assembly discipline:** prompt + cursor/file state + retrieved chunks + LSP signals,
  with lower-priority context dropped by budget ("binary search" truncation) rather than overflow
  ([Data Science Collective](https://medium.com/data-science-collective/how-cursor-actually-works-c0702d5d91a9)).

### 2.2 Edit mechanics ("Fast Apply")
- The main model emits a **semantic/lazy diff** (snippets + placement comments), a cheaper
  specialised apply model materialises the full file, then **lint/compiler feedback returns to the
  agent as a tool result** for self-correction ([Shrivu Shankar](https://blog.sshh.io/p/how-cursor-ai-ide-works)).
- Speculative edits: the existing file is the "draft", yielding ~1,000 tok/s effective apply
  ([AI Engineer](https://theaiengineer.substack.com/p/how-cursor-actually-works)).

### 2.3 Prompt & tool design (the visible craft)
From Cursor's extracted agent system prompt (Mar 2025, analysed line-by-line
[here](https://blog.sshh.io/p/how-cursor-ai-ide-works)):
- Never speak tool names to the user; explain *before* each tool call (streaming UX + trust).
- "Gather more information rather than answer partially-confident" — explicit anti-early-stop.
- MUST read what you're about to edit; fix root causes, not symptoms; never hardcode keys.
- Cap linter-fix loops at 3; never output code in chat (tools only).
- @-attachments inject full file contents in a structured block (user-supplied context is
  first-class, not pasted prose).

### 2.4 The loop
Retrieve → generate → apply → **lint/verify** → feed errors back → retry, with small models
offloading cognitive sub-tasks from the main agent ([Shrivu](https://blog.sshh.io/p/how-cursor-ai-ide-works)).

### 2.5 What Anthropic adds (Claude Code's playbook)
- **Just-in-time context:** keep lightweight identifiers (paths, queries), load data at runtime
  with tools; hybrid with small always-loaded rule files. Avoids stale indexes and context
  pollution ([Anthropic: Effective context engineering](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents)).
- **Compaction:** summarise near-full context (decisions + open bugs preserved, tool bulk dropped)
  and continue fresh; **structured note-taking** outside the window; **sub-agents** return
  1–2k-token digests from deep dives ([Anthropic](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents)).

## 3. Audit: Akosua's harness vs the levers (honest)

| Lever | Akosua today | Gap / Cursor delta |
|---|---|---|
| Phase discipline (plan before edit) | ✅ Enforced 5-phase gating, sign-offs, nudges, loop guards (20 tools/phase, 3× identical-call block) | Stronger than typical; keep |
| Independent verification | ✅ Reviewer reads the real git diff; verify gate refuses fake passes; COULD-NOT-RUN honesty | **Ahead of most** — keep, surface better |
| Research before coding | ✅ Context7 (version-pinned) → Firecrawl → YouTube(ideas), persistent cache | Differentiator; keep |
| Context retrieval | ⚠️ Lexical/structural index + hash embeddings (local, weak semantics); contract map | **Biggest gap:** no tree-sitter syntactic chunks, no quality embeddings/reranking |
| Just-in-time loading | ⚠️ Tools exist (read/grep/search) but context is largely assembled up-front per phase | Needs reference-first context + budgets |
| Compaction / long-horizon | ❌ None: history grows unbounded within a run | Add compaction + structured run notes |
| Edit mechanics | ⚠️ Surgical line-range editor with containment checks (safe), no apply-model, no post-edit lint loop into agent | Add diagnostics loop (typecheck/lint after each edit batch) |
| Prompt craft | ✅ Phase prompts with hard rules; tool descriptions treated as control surface | Continue; adopt "never speak tool names", explain-before-call as event text |
| Feedback quality | ⚠️ Raw tool outputs returned | Parse/summarise errors for the model (readable beats raw) |
| Model routing | ✅ Planner/Editor/Reviewer per-role providers | Keep; add per-phase token budgets visibility |
| Stack specialisation | ⚠️ Generic fingerprint + some gates | **Stack packs** (approved) — our asymmetry vs generalist Cursor |

## 4. How Akosua beats Cursor (for this owner) — the playbook

Cursor is a *generalist at planetary scale*; Akosua is a **specialist for one engineer's stacks**.
That asymmetry is winnable:

1. **Context, specialised (Engine-H1):** tree-sitter syntactic chunking for TS/Dart/Python;
   hybrid retrieval = contracts/graph (deterministic: routes, DTOs, NATS topics→consumers,
   Prisma/TypeORM entities, Riverpod providers) + semantic search + ripgrep; reranked, budgeted
   per phase. Deterministic contract context is something embeddings alone never give Cursor.
2. **Context discipline (H2):** token budgets per phase with visible accounting; just-in-time
   references; stale-tool-result truncation + compaction mid-run; structured run notes
   (`.akosua/artifacts/`) doubling as the Antigravity-style evidence trail.
3. **Edit-and-diagnose loop (H3):** after each edit batch, run the stack's cheapest oracle
   (typecheck/analyze/lint on touched packages) and return *parsed* diagnostics to the agent;
   capped fix loops (Cursor's "3 strikes" rule, enforced by the harness, not the prompt).
4. **Tool craft (H4):** fewer, sharper tools; descriptions as behaviour control; parallel search
   calls; outputs summarised for model consumption (paths+lines, not file dumps).
5. **Verification supremacy (H5):** per-stack gates (Nest build/test, Next build, flutter analyze/
   test, prisma validate) + reviewer-on-diff + contract-drift warnings — *finishing* is defined
   by evidence, which is exactly where generic agents quietly fail their users.
6. **Stack packs as prompts-with-teeth (H6):** version-pinned docs routing (Context7 first),
   framework idioms as rules (Riverpod codegen, Nest transport patterns), and pack-specific
   failure playbooks ("NATS consumer ack semantics before touching handlers").
7. **Measure ourselves (H7):** a small private benchmark — the sample monorepo + real past tasks —
   run per harness change (same model, tasks, budget). We tune by evidence, like the literature
   says, not by vibes. (This also keeps us honest about "better than Cursor" claims.)

## 5. Sequencing with the UI program

- UI-1 → UI-3 (identity, native chat, gates/evidence) make the harness *visible and steerable*.
- H1–H4 land inside UI-4/UI-5 (Brain & stack packs phase).
- H7 benchmark harness is built once, early, cheap — before stack packs, so pack work is measured.
