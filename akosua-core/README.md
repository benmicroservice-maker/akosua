# @akosua/core (v0.2.0)

Framework-independent heart of Akosua. Runs in the Code-OSS workbench (Phase 2 integration) and in Node for tests.

- `src/providers/` — Claude (Anthropic) + OpenAI streaming providers behind one interface; keys only via `SecretStore`.
- `src/agent/` — **phase-gated agent loop**: Understand -> Research -> Plan -> Build -> Verify. Tools declare their phases; mutations (file_editor create/insert/str_replace) are physically blocked outside `build`.
- `src/tools/` — `file_editor` (view/create/insert/str_replace, workspace-confined) + research tools (Context7, Firecrawl search/scrape, YouTube search/learn).
- `src/context/fingerprint.ts` — stack fingerprinting from evidence (NestJS Fastify/Express + NATS/Kafka/RabbitMQ/Redis + Prisma/TypeORM, Next.js, Flutter/Riverpod, Python; monorepo/monolith) + Project Brain renderer.
- `src/research/clients.ts` — native (non-MCP) Context7, Firecrawl, YouTube-TranscriptAPI clients with TTL caching and labelled sources (YouTube = IDEAS ONLY).

## Develop
```bash
npm install --ignore-scripts typescript@5.6 @types/node@22   # dev toolchain (sandbox-pinned)
npm test   # builds + node --test (9 tests, no network, no API keys)
```

## v0.2.0 additions
- `src/tools/terminal.ts` — persistent cross-platform terminal (Windows shell detection), `terminal` agent tool.
- `src/tools/git.ts` — non-destructive git checkpoints (`refs/akosua/checkpoints/*`), agent tool `git_checkpoint`.
- `src/context/verify.ts` — `run_verification` tool: fingerprinted commands -> evidence report.
- `src/context/indexer.ts` — structural + contract indexer with incremental hashes; Brain v2.
- Test fixture: `../../test-projects/sample-monorepo` (NestJS+Fastify/NATS/Prisma + Next.js + Flutter/Riverpod).
