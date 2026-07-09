# Deployment with Vercel (Hybrid Pattern)

## Short answer

Vercel is appropriate for control-plane and web product surfaces.

Vercel is not appropriate as the primary media-plane runtime for long-lived WebSocket transport servers in this architecture.

## Verified platform constraints

From current Vercel documentation:

- Vercel Functions do not support WebSocket connections.
- If you need WebSockets with Vercel, use third-party realtime providers.
- Vercel recommends rendering/edge workloads and can be paired with dedicated servers for persistent connection workloads.

References:

- [Vercel guide: Do Vercel Serverless Functions support WebSocket connections?](https://vercel.com/guides/do-vercel-serverless-functions-support-websocket-connections)
- [Vercel limits overview](https://vercel.com/docs/limits/overview)
- [Vercel guidance on using separate servers/VPS (from limits docs)](https://vercel.com/docs/limits/overview)

## What this means for Kuralle transports

### Good fit on Vercel

- control APIs (auth, orchestration, webhooks)
- product UI and dashboards
- non-persistent request/response APIs

### Not a good fit on Vercel

- primary host for `@kuralle/livekit-plugin-transport-ws`
- primary host for Twilio media WebSocket endpoints
- SIP RTP media plane (`@kuralle/livekit-plugin-transport-sip`)

## Recommended Vercel architecture

Use a hybrid deployment:

1. Vercel app for control plane and web UI.
2. Dedicated media edge services on Fly/Railway/VPS/Kubernetes.
3. Shared session store and observability across both layers.

```mermaid
flowchart LR
  U["Web Client / PSTN Provider"] --> V["Vercel Control Plane"]
  V --> M["Media Edge (WS/Twilio/SIP)"]
  M --> C["Kuralle Voice Session Runtime"]
  C --> S["Session Store (Redis/Postgres)"]
```

## Why hybrid is the right compromise

- you retain Vercel DX for product velocity
- you keep persistent media workloads on infrastructure designed for that behavior
- transport package boundaries stay intact
- scaling policy can differ by control and media planes

## Vercel control-plane blueprint

```ts
// Example: control endpoint on Vercel
export async function POST(req: Request): Promise<Response> {
  const body = await req.json();
  const callId = body.callId;

  // Validate auth/signature, perform admission checks, create session reservation.
  await reserveCall(callId);

  return Response.json({
    ok: true,
    mediaEndpoint: process.env.MEDIA_EDGE_URL,
    token: await issueAccessToken(callId),
  });
}
```

## Media-plane blueprint (non-Vercel runtime)

```ts
const twilioServer = new TwilioAgentServer({ port: 3000 });

twilioServer.onCall(async (callId) => {
  if (!(await reservationStore.isReserved(callId))) {
    return; // reject or terminate cleanly
  }

  const voiceSession = new KuralleVoiceSession({
    runtime,
    stt,
    tts,
    greeting: null,
  });
  await twilioServer.startSession(callId, voiceSession);
});
```

## Transport recommendations when Vercel is in the stack

1. Keep `transport-http` endpoints for request/response control APIs on Vercel if desired.
2. Host `transport-ws` and `transport-twilio` on dedicated media infrastructure.
3. Keep `transport-sip` outside Vercel in network-controllable environments.
4. Use shared runtime store and trace IDs to correlate control-plane and media-plane events.

## Operational checklist for hybrid

1. control-plane request includes correlation IDs propagated to media plane.
2. media-plane admission checks against control-plane reservations.
3. webhook signature validation done at control plane.
4. fallback behavior defined when control plane is reachable but media plane is saturated.
5. dashboards show both control-plane latency and media-plane session quality metrics.

## Decision rule

If you want Vercel in this platform, use it deliberately:

- Vercel for web/control.
- Dedicated infrastructure for real-time media transports.

That gives you product velocity without compromising call quality and transport correctness.
