# Deployment on Railway

## Purpose

This guide explains how to deploy Kuralle LiveKit transport services on Railway for production usage.

It is focused on real-time voice workloads, where session lifecycle, connection stability, and teardown correctness matter more than static request throughput.

## Verified platform constraints

From current Railway documentation:

- Railway public networking is HTTP/HTTPS oriented.
- Non-HTTP public exposure is through TCP Proxy.
- Private networking supports both TCP and UDP between Railway services.
- Horizontal scaling is replica-based; traffic is load-balanced across replicas.
- Railway does not currently provide sticky sessions at the platform layer.

References:

- [Railway Public Networking](https://docs.railway.com/networking/public-networking)
- [Railway TCP Proxy](https://docs.railway.com/networking/tcp-proxy)
- [Railway Private Networking](https://docs.railway.com/networking/private-networking/how-it-works)
- [Railway Scaling](https://docs.railway.com/reference/scaling)
- [Railway Deployments](https://docs.railway.com/deployments/reference)
- [Railway Healthchecks](https://docs.railway.com/reference/healthchecks)

## When Railway is a good fit

Use Railway when you want:

- fast deployment workflow with container-based services
- straightforward horizontal scaling with replicas
- managed ingress for HTTP/HTTPS and TCP
- multi-service deployment in one project with private networking

For this stack, Railway is a strong fit for:

- `@kuralle/livekit-plugin-transport-http`
- `@kuralle/livekit-plugin-transport-ws`
- `@kuralle/livekit-plugin-transport-twilio`
- control-plane APIs for any transport

## Important caveat for SIP RTP

`@kuralle/livekit-plugin-transport-sip` is SIP + RTP focused. RTP traffic is UDP-heavy and often needs predictable ingress/network behavior.

Railway public ingress model is HTTP/HTTPS + TCP Proxy, so SIP RTP should be validated carefully before committing production traffic.

Practical recommendation:

- keep SIP RTP on dedicated infrastructure (VPS/VM/Kubernetes node pool) unless you have already validated end-to-end provider compatibility on Railway for your exact call path and media requirements.

## Architecture pattern on Railway

Recommended layout:

1. `voice-control` service
2. `voice-edge-ws-http` service
3. `voice-edge-twilio` service
4. optional data services (`redis`, `postgres`) or external managed providers

Design rules:

- one active call maps to one transport ID and one runtime session ID
- session state is externalized to store (`sessionStore`)
- control-plane endpoints and media-plane endpoints are isolated by service

## Build and deployment blueprint

### Dockerfile blueprint

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

# Example: Twilio transport edge
CMD ["bun", "run", "apps/playground/transport-examples/twilio-support/index.ts"]
```

### Service configuration blueprint

Configure each service with:

- health endpoint (`/healthz`) returning `200`
- explicit `PORT` listening
- restart policy suitable for long-running workloads
- enough replicas to cover busy-hour concurrency with headroom

Deployment behavior notes:

- Railway sends `SIGTERM` to old deployments and allows configurable draining via service variable.
- use `RAILWAY_DEPLOYMENT_DRAINING_SECONDS` for graceful connection teardown.
- if you need overlap during rollout, configure deployment overlap variable accordingly.

## Runtime blueprint (per service)

```ts
import { Runtime } from '@kuralle-agents/core';
import { RedisSessionStore } from '@kuralle-agents/redis-store';
import { KuralleVoiceSession } from '@kuralle/livekit-plugin';
import { WebSocketAgentServer } from '@kuralle/livekit-plugin-transport-ws';
import { initializeLogger } from '@livekit/agents';

initializeLogger({ pretty: false, level: process.env.LOG_LEVEL ?? 'info' });

const runtime = new Runtime({
  agents,
  defaultAgentId: 'assistant',
  defaultModel: openai('gpt-4o-mini'),
  sessionStore: new RedisSessionStore({
    client: redisClient,
    prefix: 'aria-voice-railway',
  }),
});

const server = new WebSocketAgentServer({ port: Number(process.env.PORT ?? 8080) });

server.onConnection(async (transport) => {
  const voiceSession = new KuralleVoiceSession({ runtime, stt, tts, greeting: null });
  await server.startSession(transport, voiceSession);
});

await server.listen();
```

## Scaling policy

Start from measured concurrency, not call/day alone.

Recommended progression:

1. 10-100 calls/day: single replica per active transport service, one warm instance always on.
2. 100-1000 calls/day: split Twilio from WS/HTTP and add replicas by busy-hour concurrency.
3. 1000-3000 calls/day: multi-region replicas and explicit admission control.

Because sticky sessions are not platform-guaranteed, avoid any design that relies on in-memory affinity.

## Railway checklist for production readiness

1. Health checks configured and tested on deploy.
2. Graceful draining configured and validated with active sessions.
3. Per-service replicas set from busy-hour targets.
4. External session store enabled and observed under reconnect/restart.
5. Structured session logs include transport ID, provider call ID, runtime session ID.
6. Soak tests executed with realistic call durations and reconnect patterns.

## Suggested use in your platform strategy

For your ElevenLabs/Vapi/Retell-like target:

- Railway can be a strong option for control plane and HTTP/WS/Twilio edges.
- Keep SIP RTP as a separate telephony lane unless validated thoroughly.
- Preserve transport package boundaries so you can move one edge to another runtime without rewriting core logic.
