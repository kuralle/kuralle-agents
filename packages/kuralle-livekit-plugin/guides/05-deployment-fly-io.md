# Deployment on Fly.io

## Purpose

This guide provides a Fly.io deployment blueprint for Kuralle LiveKit transport pipelines, modeled after the structure and intent of Pipecat's Fly deployment guide, but adapted to this codebase and transport architecture.

Reference:

- [Pipecat deployment on Fly.io](https://docs.pipecat.ai/deployment/platforms/fly)

## What we are deploying

For production behavior, deploy transport edges as independently scalable services where possible:

1. `voice-edge-ws-http` for WebSocket and HTTP/SSE traffic
2. `voice-edge-twilio` for Twilio Media Streams
3. `voice-edge-sip` for SIP RTP trunking, only if you truly need trunk telephony

You can start with one service and split later, but the split architecture should be your target state.

## Why Fly can work for this

Fly gives:

- region placement close to users/providers
- machine autoscaling and autostart/autostop controls
- health checks and rolling deployment controls

Key Fly docs used:

- [Autostop/autostart machines](https://fly.io/docs/launch/autostop-autostart/)
- [App configuration reference](https://fly.io/docs/reference/configuration/)
- [Concurrency settings](https://fly.io/docs/apps/concurrency/)

## Important platform constraints for voice workloads

Voice sessions are long-lived and stateful over each connection, even though worker processes should be stateless between calls.

For voice workloads:

- do not rely on cold starts in business hours if low answer latency matters
- keep at least one machine running in each active region
- tune concurrency based on active streaming sessions, not only request counts

Fly concurrency supports connection-aware controls (`type = "connections"`), which is usually a better mental model for streaming transports than request-per-second alone.

## Deployment model options on Fly

### Model A: Single app

Use when call volume is low and risk tolerance is high.

- one app handles ingress + media for selected transports
- fastest initial setup
- harder to isolate failures

### Model B: App-per-transport edge (recommended)

Use when you need predictable operations.

- separate app for WS/HTTP
- separate app for Twilio
- optional separate app for SIP RTP
- each app gets its own scaling and deploy cadence

### Model C: Split control and media apps

Use when you need better admission control and multi-region burst handling.

- control app handles auth, webhooks, orchestration, token/session setup
- media app(s) handle long-lived streaming sessions

## Prerequisites

1. `flyctl` installed and authenticated
2. Docker build that can run your selected transport server entrypoint
3. external state stores ready (Redis/Postgres) for runtime session durability
4. provider webhooks and callback domains prepared (Twilio/SIP provider/etc.)

## Example Dockerfile blueprint

This Dockerfile focuses on one transport edge process and keeps startup deterministic.

```dockerfile
FROM oven/bun:1.2 AS build
WORKDIR /app

COPY package.json bun.lockb ./
COPY packages ./packages
COPY apps ./apps

RUN bun install --frozen-lockfile
RUN bun run build

FROM oven/bun:1.2
WORKDIR /app

COPY --from=build /app /app

ENV NODE_ENV=production
ENV LOG_LEVEL=info

# Example command: Twilio edge app
CMD ["bun", "run", "apps/playground/transport-examples/twilio-support/index.ts"]
```

If you move from playground entrypoints to dedicated production entrypoints, update `CMD` accordingly.

## Example `fly.toml` for WS/HTTP or Twilio edge

```toml
app = "kuralle-voice-edge"
primary_region = "sin"

[build]
  dockerfile = "Dockerfile"

[env]
  NODE_ENV = "production"
  LOG_LEVEL = "info"

[http_service]
  internal_port = 3000
  force_https = true
  auto_start_machines = true
  auto_stop_machines = "off"
  min_machines_running = 1
  processes = ["app"]

  [http_service.concurrency]
    type = "connections"
    soft_limit = 40
    hard_limit = 60

[[http_service.checks]]
  interval = "15s"
  timeout = "5s"
  grace_period = "20s"
  method = "GET"
  path = "/healthz"

[[vm]]
  cpu_kind = "shared"
  cpus = 2
  memory = "1024mb"
```

Notes:

- `auto_stop_machines = "off"` avoids idle shutdown behavior that can hurt first-call latency.
- `min_machines_running = 1` keeps warm capacity.
- use `connections` limits for streaming workloads.

## Secrets and environment configuration

Set secrets with `fly secrets set`, for example:

```bash
fly secrets set \
  OPENAI_API_KEY=... \
  GEMINI_API_KEY=... \
  REDIS_URL=... \
  SESSION_STORE_PREFIX=aria-voice-prod \
  LOG_LEVEL=info
```

Never hardcode these in files committed to source control.

## Deploy and verify

```bash
fly launch --no-deploy
fly deploy
fly status
fly logs
```

Verification checklist:

1. health endpoint passes in all running machines
2. transport handshake succeeds (`/session`, websocket connect, Twilio stream start)
3. per-call session IDs are unique and logged
4. normal stop and abnormal disconnect both run deterministic teardown

## Scaling policy guidance

### Baseline recommendation

- keep one warm machine in primary region
- scale count from observed busy-hour concurrency
- tune connection soft/hard limits from soak-test results

### Burst handling

- prefer fast horizontal scaling over very large single machines
- use queue/admission control so new calls can be throttled gracefully
- reject overload explicitly instead of letting sessions degrade silently

## SIP RTP on Fly: practical guidance

`@kuralle/livekit-plugin-transport-sip` uses UDP SIP signaling and RTP media assumptions.

Before committing SIP RTP to Fly in production, validate:

1. inbound UDP SIP reachability and provider compatibility
2. RTP port range exposure strategy
3. NAT/egress identity requirements from your SIP provider
4. packet-loss and jitter behavior under load

If your provider expects fixed network behavior and broad UDP media ranges, a dedicated SIP edge (VM or Kubernetes node pool with direct network control) may be operationally simpler than forcing everything through the same HTTP-first platform layer.

Use Fly confidently for:

- WS transport
- HTTP/SSE transport
- Twilio transport (WebSocket media stream ingress)

Treat SIP RTP as a separate decision with explicit network validation.

## Deployment blueprint for a production-like split

```ts
// control-plane app
app.post('/twilio/webhook', validateTwilioSignature, async (req, res) => {
  const callId = getCallId(req);
  await admissionController.reserve(callId);
  res.send(twimlForMediaStream(process.env.TWILIO_WS_URL!));
});

// media-plane app
twilioServer.onCall(async (callId) => {
  if (!admissionController.isReserved(callId)) {
    // Fail early instead of letting runtime overload
    return;
  }

  const voiceSession = new KuralleVoiceSession({ runtime, stt, tts, greeting: null });
  await twilioServer.startSession(callId, voiceSession);
});
```

This keeps orchestration and media handling separate, which is easier to scale and debug.

## Operational runbook basics

Track these during live operations:

- active sessions by transport and region
- p50/p95/p99 turn latency
- model/STT/TTS provider error rates
- transport disconnect reasons
- machine restarts and deployment rollouts

Alert on:

- sustained active sessions near hard limit
- rising handshake failures
- repeated abnormal teardown paths
- store connectivity degradation

## Recommended next step

After this Fly guide is implemented, apply `06-capacity-and-transport-selection.md` to convert traffic forecasts (10/day to 3000/day) into hard capacity and transport policy.
