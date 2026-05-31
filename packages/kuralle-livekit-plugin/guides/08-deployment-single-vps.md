# Deployment on a Single VPS

## Purpose

This guide describes how to run Kuralle LiveKit transport services on a single VPS with production-grade operational controls.

This is the most direct option when you need:

- full network control (especially for SIP/RTP)
- predictable process behavior
- lower platform abstraction and fewer hidden routing constraints

## When single VPS is appropriate

A single VPS is appropriate for:

- early to mid traffic with strong operational ownership
- pilot deployments with SIP trunking requirements
- one-region deployments where you can tolerate region-level blast radius

It is usually the simplest path for SIP RTP readiness because you can control:

- UDP and TCP ports
- firewall rules
- OS-level network and process settings

## Baseline system design

Recommended host topology:

1. reverse proxy (`nginx` or `caddy`) for HTTP/HTTPS and WebSocket termination
2. process supervisor (`systemd` recommended) for transport services
3. Redis/Postgres (local or managed) for session persistence
4. central structured logs and metrics export

Possible process split on one VPS:

- `voice-control` (HTTP API)
- `voice-edge-ws-http`
- `voice-edge-twilio`
- `voice-edge-sip` (if needed)

## Why this model works

- no platform-level sticky-session assumptions required
- clear process ownership per transport
- easy deterministic graceful shutdown with `systemd`

## OS and host hardening baseline

1. dedicate non-root service user
2. lock down inbound firewall to required ports only
3. enable automatic security patching policy
4. enforce TLS certificates (Let's Encrypt or managed cert path)
5. configure log rotation and disk pressure alerts

## Reverse proxy blueprint (Nginx for WS/HTTP/Twilio webhook)

```nginx
server {
  listen 443 ssl;
  server_name voice.example.com;

  ssl_certificate     /etc/letsencrypt/live/voice.example.com/fullchain.pem;
  ssl_certificate_key /etc/letsencrypt/live/voice.example.com/privkey.pem;

  # HTTP/SSE edge
  location /session {
    proxy_pass http://127.0.0.1:3001;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_read_timeout 3600s;
  }

  # WS edge
  location /ws {
    proxy_pass http://127.0.0.1:3002;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Host $host;
    proxy_read_timeout 3600s;
  }

  # Twilio webhook endpoint in control plane
  location /twilio/webhook {
    proxy_pass http://127.0.0.1:3000;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
  }
}
```

## `systemd` service blueprint

```ini
[Unit]
Description=Kuralle Twilio Edge
After=network.target

[Service]
Type=simple
User=kuralle
WorkingDirectory=/opt/aria-flow
Environment=NODE_ENV=production
Environment=LOG_LEVEL=info
EnvironmentFile=/etc/kuralle/twilio-edge.env
ExecStart=/usr/local/bin/bun run apps/playground/transport-examples/twilio-support/index.ts
Restart=always
RestartSec=3
TimeoutStopSec=45
KillSignal=SIGTERM

[Install]
WantedBy=multi-user.target
```

Service behavior rules:

- receive `SIGTERM`
- stop accepting new sessions
- close active sessions deterministically
- exit before `TimeoutStopSec`

## SIP/RTP deployment notes

For `@kuralle/livekit-plugin-transport-sip` on VPS:

1. open SIP signaling port (default 5060 UDP/TCP as needed)
2. open RTP media port range
3. ensure provider ACL and routing configuration match your VPS public IP
4. monitor RTP packet loss, jitter, and teardown correctness

This is usually easier on VPS than on higher-level platforms.

## Runtime blueprint

```ts
import { Runtime } from '@kuralle-agents/core';
import { RedisSessionStore } from '@kuralle-agents/redis-store';
import { KuralleVoiceSession } from '@kuralle/livekit-plugin';
import { SIPAgentServer } from '@kuralle/livekit-plugin-transport-sip';
import { initializeLogger } from '@livekit/agents';

initializeLogger({ pretty: false, level: process.env.LOG_LEVEL ?? 'info' });

const runtime = new Runtime({
  agents,
  defaultAgentId: 'assistant',
  defaultModel: openai('gpt-4o-mini'),
  sessionStore: new RedisSessionStore({ client: redisClient, prefix: 'aria-voice-vps' }),
});

const sip = new SIPAgentServer({
  localAddress: process.env.SIP_LOCAL_ADDRESS!,
  sipPort: Number(process.env.SIP_PORT ?? 5060),
  rtpPortStart: Number(process.env.RTP_PORT_START ?? 10000),
  codec: 'PCMU',
});

sip.onCall(async (_adapter, callId) => {
  const voiceSession = new KuralleVoiceSession({ runtime, stt, tts, greeting: null });
  await sip.startSession(callId, voiceSession);
});

await sip.listen();
```

## Capacity guidance for single VPS

Single VPS can comfortably cover early usage if you enforce hard limits.

Recommended:

- set per-transport max active sessions
- reject overload explicitly
- monitor CPU, memory, and network saturation

At around sustained medium concurrency, split services to additional nodes before quality degradation appears in live calls.

## Operational checklist

1. TLS termination and webhook signature validation enabled.
2. Session store is persistent and externalized.
3. Graceful shutdown tested during rolling restart.
4. Active call metrics and teardown reason logs are emitted.
5. Daily backup/retention policy in place for critical operational data.
6. Alerting configured for process crash loops and store connectivity issues.

## Migration path from single VPS

When traffic grows:

1. keep control plane on current node
2. move media edges (WS/Twilio/SIP) to dedicated nodes
3. keep same transport package boundaries and runtime contracts
4. add region or provider-specific ingress later without redesigning core plugin code
