# Akosua — Native Research Tools Live Test (2026-10-18)

Keys supplied in chat by the user, used only via process environment in a
temporary /tmp runner, never written to any workspace file. Runner deleted.

## Results
| Tool | Test | Result |
|---|---|---|
| Context7 (native) | docs("NestJS", topic="@Param route parameter in controller") | ✅ OK ~3.4s, 3,551 chars — returned current NestJS docs excerpts incl. `@Get(':id') findOne(@Param('id') id: string)` from docs.nestjs.com sources |
| Firecrawl search (native) | search("NestJS @Param route parameter controller example", 3) | ✅ OK ~0.8s — official docs + Stack Overflow + LogRocket, correctly source-labelled "verify before applying" |
| Firecrawl scrape (native) | scrape(https://docs.nestjs.com/controllers) | ✅ OK ~0.4s, 35,015 chars markdown |

This validates the intended division of labour live, not just in unit tests:
Context7 = version-pinned primary docs; Firecrawl = web research / docs fallback.

## YouTube / TranscriptAPI
The key from earlier in this conversation was deliberately never saved to the
workspace, and the condensed session record redacts it — so the assistant no
longer holds a usable copy. User to re-send if a live YouTube test is wanted
now (or enter it later in Akosua's Settings → Providers & Keys, which is the
permanent home for all of these keys).

## Security note
All chat-pasted keys (OpenAI, Context7, Firecrawl, and TranscriptAPI when
re-sent) should be revoked/rotated by the user once live testing is done and
re-issued fresh inside Akosua's Settings (SecretStorage → Windows Credential
Manager).

## YouTube / TranscriptAPI — retest (later same day)
User re-sent a TranscriptAPI key. Tested env-only via the native client AND via
raw curl (no Akosua code) against both `/youtube/search` and the FREE
`/youtube/info` endpoint. TranscriptAPI docs re-checked 2026-10-18: Bearer auth
+ `/api/v2` base — our client matches. Result in all cases:
`401 {"detail":"Invalid API key"}`. Diagnosis: the key string as sent is
rejected by TranscriptAPI itself (mistyped / revoked / inactive). Action:
user to copy it fresh from transcriptapi.com/dashboard/api-keys (or regenerate)
and re-send; client code needs no change. Key never written to a workspace file.
Retest of the re-sent key: still 401 via the native client, and 401 under every
auth variant tried by raw curl (Bearer, X-API-Key, api-key header, api_key
query param, raw Authorization token) on the free /youtube/info endpoint.
Conclusion: TranscriptAPI does not recognise this key string at all. Next step
is on the dashboard side: verify the key exists/active there, or generate a
new one (a new key will differ from this string — if it looks identical,
it was not regenerated).

## YouTube / TranscriptAPI — PASSED (new key, later same day)
A fresh (visibly different) key was accepted immediately. The test then exposed
a REAL client bug: TranscriptAPI's search endpoint now requires `q`, not
`query` (400 "Either 'q' or 'continuation' is required"). Fixed in
`src/research/clients.ts` per the current docs + improved search output to
`title — watch URL (channel, length, views)` lines. Suite still 21/21.
Live after fix:
- search("NestJS NATS JetStream microservices tutorial") → 10 real results
  (Anson 2h20m NestJS+NATS course, Synadia, Ardan Labs, ...), IDEAS-ONLY labelled.
- learn(top result) → 24,125 chars timestamped transcript ("[0.64s] hey everyone
  my name is anen today I'm going to teach you all how to set up microservices
  in NestJS..."), video title cited, IDEAS-ONLY banner present.

Status: ALL research natives live-verified — Context7 ✅ Firecrawl ✅ YouTube ✅
(previous TranscriptAPI key string remains dead and should be deleted on the
dashboard; all chat-pasted keys to be rotated once testing ends).
