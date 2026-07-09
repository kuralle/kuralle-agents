# cf-voice-realtime-gemini — Wave 3 runbook

End-to-end browser demo for the Kuralle realtime voice stack on Cloudflare.

| Piece | Where |
|---|---|
| Realtime mixin | [`@kuralle-agents/cf-agent/voice`](../../src/voice/) — Cloudflare realtime voice |
| Provider | [`CloudflareGeminiLiveClient`](../../../realtime-audio/src/cloudflare/gemini-live.ts) — Gemini Live provider |
| Wire protocol | [`@kuralle-agents/voice-protocol`](../../../voice-protocol/) — browser/worker voice protocol |
| Browser hook | `@cloudflare/voice/react` — `useVoiceAgent` |
| Model | `gemini-3.1-flash-live-preview` (half-cascade) |
| Voice | `Charon` (fallback: `Puck` — see FINDINGS) |

## Prerequisites

- Cloudflare account with Workers Paid plan (Durable Objects require paid).
- Google AI Studio / Gemini API key with access to `gemini-3.1-flash-live-preview`.
- `wrangler login` authenticated.
- `bun` or `pnpm` available; this example builds with Vite + `@cloudflare/vite-plugin`.

## One-time setup

```bash
# From this directory:
wrangler secret put GEMINI_API_KEY
# Paste your Gemini API key when prompted.
```

## Deploy

```bash
pnpm install           # resolves workspace deps
pnpm run deploy        # vite build → wrangler deploy
```

On success the command prints a `https://cf-voice-realtime-gemini.<subdomain>.workers.dev` URL. Open it in a browser that can hit a microphone (Chrome / Safari / Firefox).

## Browser smoke test — 5 steps

Open the deployment URL and verify, in order:

1. **Status reaches `idle`.** The banner under the title should flip from `connecting` to `idle` within ~2s. Log signature (via `wrangler tail`): `welcome` frame + `{"type":"status","status":"idle"}`.
2. **Start call → `listening`.** Click *Start call*. Status should move through `connecting` → `listening`. Browser prompts for mic permission; grant it. Log signature: `audio_config` frame + `{"type":"status","status":"listening"}`.
3. **Audio round-trip.** Say: *"Hello, can you hear me?"* Within ~1-3s, interim text appears, then a final transcript line, and the assistant replies with audio (Charon voice). Status passes `thinking` → `speaking` → `listening`. Log signature: `transcript` events alternating `role: user` / `role: assistant`.
4. **Tool call.** Say: *"What's the weather in Tokyo?"* The assistant should announce it's checking, then narrate `21°C, partly cloudy`. Log signature: `toolCall` + `sendToolResponse` with `{ result: { city: 'Tokyo', temperatureC: 21, condition: 'partly cloudy' } }`.
5. **Interrupt / barge-in.** While the assistant is speaking a longer reply, say something mid-response. Audio should cut within ~300ms and the status returns to `listening`. Log signature: `interrupted` event + `{"type":"status","status":"listening"}`.

> Bonus (optional): Leave the call open > 15 minutes. The provider emits `goAway` when it's about to drop; the mixin reconnects using the handle persisted in `cf_realtime_resumption`. Audio should continue without user intervention. Log signature: `sessionResumptionUpdate` row in the `cf_realtime_resumption` SQLite table.

## Acceptance — realtime voice is shipped

All five steps above pass on a deployed URL. If any step regresses, grab the failure surface from `wrangler tail` and paste into the PR for triage before merging Wave 3.

## Troubleshooting

| Symptom | Fix |
|---|---|
| `wrangler deploy` errors with `Durable Object requires Workers Paid` | Upgrade the Cloudflare account to Workers Paid. |
| Status stays `connecting` | Check `wrangler tail` for DO instantiation errors. Most common: `GEMINI_API_KEY` secret missing — rerun `wrangler secret put GEMINI_API_KEY`. |
| Provider rejects voice `Charon` | `gemini-3.1-flash-live-preview` (half-cascade) may not expose the native-audio voice set. Set `VOICE = "Puck"` in `src/server.ts` and redeploy; document in FINDINGS. |
| Model name rejected | Verify at <https://ai.google.dev/gemini-api/docs/live> that `gemini-3.1-flash-live-preview` is still listed. Fallback: `gemini-2.0-flash-live-001`. |
| Browser shows `"Agent unavailable"` | Worker deployed but route mismatch — confirm the DO class binding name in `wrangler.jsonc` matches the class exported from `src/server.ts` (`CfVoiceRealtimeAgent`). |
| Interrupt feels laggy (>500 ms) | Provider interrupt latency is network-bound; if sustained, capture timing metrics and treat as a Gemini Live regression, not a Kuralle bug. |

## Architecture

```
┌──────────────┐   WebSocket    ┌──────────────────────┐   WSS    ┌─────────────┐
│  Browser     │ ◄────────────► │  Worker              │ ◄──────► │ Gemini Live │
│              │                │   ↓ routeAgentRequest│          │  (provider) │
│ useVoiceAgent│                │  CfVoiceRealtimeAgent│          └─────────────┘
│   + React 19 │                │   ↓ withRealtimeVoice│
└──────────────┘                │  CloudflareGeminiLive│
                                │    Client (Gemini)   │
                                │                      │
                                │  cf_realtime_resumption
                                │  cf_ai_chat_agent_messages (voice transcripts
                                │    tagged metadata.source="voice")
                                └──────────────────────┘
```

See the voice platform program docs for the realtime voice and Gemini Live
provider contracts.
