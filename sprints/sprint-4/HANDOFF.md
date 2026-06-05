# Handoff — Sprint 4 → PROGRAM COMPLETE

> **One page.** Streaming-by-default is shipped: `0.4.0` is LIVE on npm.

## State of the world
All 5 sprints (0–4) of the streaming-by-default build are closed. The breaking `text-start`/`text-delta{id,delta}`/`text-end`/`text-cancel` lifecycle, the shared `speakGated` emitter, sentence/turn/token modes, native-realtime advisory gate (REQ-9), and cascaded TTFT are implemented, tested, reviewed (two `/delegate-review` rounds + fixes), documented (ADR-0004), and **published as `0.4.0`** (28 packages live on npm, tag `v0.4.0`, commit `b6c4f25`).

## Remaining human steps (not done autonomously)
1. **Merge `plan/streaming-by-default` → `main`** (PR or fast-forward) — main currently lags the released 0.4.0. The released code lives on the build branch + npm.
2. **(Optional, recommended before next release) Clear B-06** — 4 pre-existing test/example tsconfigs fail `typecheck:all`; they don't ship (tarballs build from `src`, clean), but fixing them gives a fully-green gate.
3. **(Optional) Live TTS TTFT number** — the cascaded e2e is skip-guarded; run with LiveKit+OpenAI keys to capture a real TTFT figure (the deterministic adapter proof already confirms first-token behavior).
4. **Downstream:** external Studio `SSEChatTransport` migrates `part.text` → `part.delta` (B-05).

## Backlog (open)
- B-05 (downstream Studio migration), B-06 (typecheck drift — release-quality), B-07 (possible dead `AgentStreamPart` hook surface), B-08 (live-Gemini transcript double-fire).

## Verify the release
```bash
npm view @kuralle-agents/core version   # -> 0.4.0
git tag --list v0.4.0
```
