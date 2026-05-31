# Local Development and Testing Guide

## Purpose

This guide is the practical runbook for developing and validating the Kuralle LiveKit transport stack on a local machine.

It is written for day-to-day engineering workflows:

- install and bootstrap workspace dependencies
- run builds and typechecks
- execute transport test suites
- run each transport example locally and verify behavior

## Scope

This guide covers:

- core plugin package (`@kuralle/livekit-plugin`)
- transport packages (WS, HTTP, Twilio, SIP, JsSIP, SmartPBX)
- playground examples under:
  - `apps/playground/transport-examples`

## Prerequisites

1. Bun installed and on PATH.
2. Node-compatible tooling available for TSX scripts used in examples.
3. API keys for model providers:
   - `OPENAI_API_KEY`
   - `GOOGLE_API_KEY`
4. Optional tools for protocol testing:
   - `wscat` for websocket manual tests
   - SIP softphone (`Linphone`, `Zoiper`) for SIP tests
   - `ngrok` or equivalent tunnel for Twilio webhook/media tests

## Environment setup

Set local environment variables in your shell before running examples:

```bash
export OPENAI_API_KEY="..."
export GOOGLE_API_KEY="..."
export LOG_LEVEL="info"
```

If you use a `.env` loader in your shell profile, keep the same keys.

## Workspace bootstrap

From repo root:

```bash
cd kuralle-agents
bun install
```

If dependencies are corrupted or stale:

```bash
bun run fresh
```

## Build and typecheck workflow

### Full package build

```bash
bun run build
```

### Example app typecheck

```bash
bun run --cwd apps/playground/transport-examples typecheck
```

### Core plugin test typecheck

```bash
bun run --filter '@kuralle/livekit-plugin' test:typecheck
```

## Automated test workflow

### Run transport-focused tests (recommended baseline)

```bash
bun run test:transport
```

### Run core plugin tests

```bash
bun run --filter '@kuralle/livekit-plugin' test
```

### Run all workspace tests (heavier)

```bash
bun run test
```

Use this sequence for local confidence before pushing:

1. `bun run build`
2. `bun run --cwd apps/playground/transport-examples typecheck`
3. `bun run test:transport`
4. `bun run --filter '@kuralle/livekit-plugin' test`

## Local transport smoke tests

Use separate terminals for server and client actions.

## 1) HTTP/SSE transport

### Terminal A: start server

```bash
cd apps/playground/transport-examples
bun run http-support
```

### Terminal B: open SSE stream

```bash
curl -N "http://localhost:3000/session?id=local-http-1"
```

### Terminal C: send user text

```bash
curl -X POST "http://localhost:3000/session?id=local-http-1" \
  -H "Content-Type: application/json" \
  -d '{"type":"user_text","text":"Hello from HTTP local test"}'
```

Expected result:

- SSE terminal shows `session_started`, text events, and turn completion behavior.

## 2) WebSocket transport (JSON example path)

### Terminal A: start websocket audio-stream example

```bash
cd apps/playground/transport-examples
bun run websocket-audio-stream
```

### Terminal B: run bundled client

```bash
cd apps/playground/transport-examples
bun run test-client
```

Expected result:

- client receives `session_started`
- assistant text streams in partial chunks
- `turn_complete` appears after response

## 3) WebSocket transport (base protocol path)

### Terminal A: start base WS example

```bash
cd apps/playground/transport-examples
bun run websocket-support
```

### Terminal B: connect with `wscat`

```bash
wscat -c ws://localhost:8080
```

Then send:

```json
{"type":"user_text","text":"Hello from ws protocol smoke test"}
```

Expected result:

- initial `session_started` message
- assistant output events (`agent_text`, state events) and/or audio frames depending on client handling

## 4) Twilio transport

### Terminal A: start Twilio media server

```bash
cd apps/playground/transport-examples
bun run twilio-support
```

### Terminal B: expose local port

```bash
ngrok http 3000
```

Configure Twilio stream target to your tunnel endpoint and place a test call.

Expected result:

- server logs `connected`, `start`, media lifecycle
- session starts per call ID
- deterministic teardown on stop/disconnect

If you do not have a Twilio account configured locally, rely on Twilio transport unit/contract tests as the baseline signal:

```bash
bun test packages/kuralle-livekit-plugin-transport-twilio/test
```

## 5) SIP RTP transport

### Terminal A: start SIP server

```bash
cd apps/playground/transport-examples
bun run sip-support
```

### Terminal B: call with SIP softphone

Use:

- server: `127.0.0.1:5060`
- transport: UDP
- codec: PCMU preferred

Expected result:

- INVITE accepted
- RTP media path established
- call lifecycle closes cleanly on hangup

For repeatable local protocol validation:

```bash
bun test packages/kuralle-livekit-plugin-transport-sip/test
```

## 6) SmartPBX bridge transport

### Terminal A: start bridge app

```bash
cd apps/playground/transport-examples
bun run smartpbx-bridge
```

Use provider-side websocket/media events or adapter-level tests:

```bash
bun test packages/kuralle-livekit-plugin-transport-smartpbx/test
```

## Local failure triage checklist

If local run fails, check in this order:

1. Missing env vars (`OPENAI_API_KEY`, `GOOGLE_API_KEY`).
2. Package not built after branch changes (`bun run build`).
3. Port collision (`3000`, `8080`, `5060`, RTP range).
4. Invalid sample rate/encoding assumptions from client.
5. Store/network dependency misconfiguration if using persistent store locally.

## Type errors around `bun:test`

If your editor reports:

`Cannot find module 'bun:test' or its corresponding type declarations`

verify:

1. root dependencies installed (`bun install`)
2. `bun-types` exists in workspace dev dependencies
3. package test tsconfig includes bun types where needed (for this repo, transport test tsconfigs are already configured)

## Local pre-push gate (recommended)

Run this from repo root:

```bash
bun run build \
  && bun run --cwd apps/playground/transport-examples typecheck \
  && bun run test:transport \
  && bun run --filter '@kuralle/livekit-plugin' test
```

If this passes, local confidence is high enough for a normal transport-focused pull request.
