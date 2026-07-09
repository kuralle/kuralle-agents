# Sandbox Voice Agent

Deploys an ephemeral Kuralle Gemini Live voice agent into a Vercel Sandbox. The browser client connects to the sandbox URL over WebSocket and exchanges raw 24 kHz int16 mono PCM audio with Gemini Live through Kuralle realtime runtime.

## Setup

From this directory:

```sh
npm install
vercel link
vercel env pull .env.local
```

The deploy script loads:

- `.env.local` in this directory for `VERCEL_OIDC_TOKEN`
- `../../../.env` for `GOOGLE_GENERATIVE_AI_API_KEY` or `GOOGLE_API_KEY`

Port `3000` is used because port `8080` is reserved by Vercel Sandbox infrastructure.

## Run

```sh
npx tsx src/deploy.ts
```

The script:

1. Creates or reuses a local dependency snapshot.
2. Creates a runtime sandbox from the snapshot.
3. Starts `server.mjs` with detached object-form `runCommand`.
4. Polls the sandbox server's own health endpoint at `/__kuralle_health` and requires a per-run readiness token, so the sandbox proxy's default `200` response is ignored.
5. Runs an automated audio self-test with `packages/e2e-tests/fixtures/bench_hello.pcm`.
6. Prints the browser `wss://` URL.
7. Stops the sandbox after a browser session ends, Ctrl+C, or 10 minutes.

Useful options:

```sh
npx tsx src/deploy.ts --skip-audio-test
npx tsx src/deploy.ts --no-snapshot
KURALLE_EXIT_AFTER_READY=1 npx tsx src/deploy.ts --skip-audio-test
KURALLE_SANDBOX_SNAPSHOT_ID=snp_xxx npx tsx src/deploy.ts
```

The cached snapshot id is stored in `.sandbox-snapshot.json` and ignored by git. Snapshots are created with `expiration: 0` so dependency installs stay reusable for local development.

## LiveKit RealtimeModel Variant

To exercise the LiveKit RealtimeModel path instead of the plain WS transport path:

```sh
npx tsx src/deploy-livekit.ts
npx tsx src/deploy-livekit-tools.ts
npx tsx src/deploy-livekit-flow.ts
```

This variant uses `startNativeSession()` (Path B canonical) — the official LiveKit Gemini plugin owns audio while Kuralle `Runtime` drives tools / flows / hooks via `binding.controller.attach(session)`. The audio self-test waits for both outbound Gemini audio and a `turn_complete` marker.
The `tools` scenario runs a single agent with `check_weather` and `get_time` tools across three turns. The `flow` scenario runs a hospital booking flow with `check_availability` and a final `confirm_booking` transition tool across three turns.

## Browser Test

Open:

```text
../../../packages/e2e-tests/try-voice-agent/index.html
```

Paste the printed `wss://...vercel.run` URL, click Connect, unmute the mic, and speak. The server stops after the WebSocket session closes.

## Notes

- The in-sandbox server uses `http.createServer` plus `new WebSocketServer({ server })`; it does not use standalone `WebSocketAgentServer.listen()` because the Vercel Sandbox proxy needs HTTP upgrade handling on the exposed port.
- Binary audio is instrumented in both directions. The self-test fails if it sends PCM to the sandbox but receives no binary Gemini audio back.
- `deploy-gemini.ts` is kept as a compatibility wrapper for the older POC name. `deploy-sandbox.ts` remains the echo POC.
