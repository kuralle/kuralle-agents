# Multi-Platform Agent Example (WhatsApp + Instagram + Web)

One Kuralle **Runtime**, one **flow/agent** set, three channels. Channel differences (24h windows, template recovery, interactive rendering, inbound id routing) live in **`@kuralle-agents/engagement`** policies — not in the bot code.

## Architecture

```
                         ┌─────────────────────────────────────┐
  WhatsApp user ──────>  │  /messaging/whatsapp/webhook        │──┐
                         └─────────────────────────────────────┘  │
                         ┌─────────────────────────────────────┐  │   engagement({ policies:
  Instagram user ─────>  │  /messaging/instagram/webhook       │──┼──> [whatsapp, web, instagram] })
                         └─────────────────────────────────────┘  │        │
                         ┌─────────────────────────────────────┐  │        ▼
  Browser user ────────> │      /api/chat/sse (web)          │──┘   createMessagingRouter
                         └─────────────────────────────────────┘         + shared Runtime
```

- **`engagement({ policies })`** → `{ bridge, broadcasts }`. Spread **`...eng.bridge`** into `createMessagingRouter` (outbound chain, inbound resolver, window store, consent, ownership).
- **`webPolicy()`** is the null adapter (`hasWindow: false`) — web chat uses the same runtime via `createKuralleChatRouter`; Meta channels use webhook clients.
- The example flow uses **`withChoices`** on a `decide` node so the runtime emits `{ type: 'interactive' }` parts; each policy renders them for its channel (buttons/list vs carousel, same option ids).

## Prerequisites

1. A **Meta Developer** app with **WhatsApp Cloud API** and **Instagram Messaging** products
2. **OpenAI** API key (support agent + template selector)
3. **ngrok** (or similar) for local webhook forwarding

## Environment Variables

Required when **running** the server (not for `typecheck:all`):

```bash
# WhatsApp Cloud API
WHATSAPP_ACCESS_TOKEN=
WHATSAPP_APP_SECRET=
WHATSAPP_PHONE_NUMBER_ID=
WHATSAPP_VERIFY_TOKEN=
WHATSAPP_WABA_ID=

# Instagram Messaging API
INSTAGRAM_ACCESS_TOKEN=
INSTAGRAM_APP_SECRET=
INSTAGRAM_ACCOUNT_ID=
INSTAGRAM_VERIFY_TOKEN=

# OpenAI
OPENAI_API_KEY=

# Optional
PORT=3333
```

## Running

```bash
# From repo root
bun install
bun run build

# From packages/messaging-meta
npx tsx examples/multi-platform/server.ts
```

## Webhook Setup with ngrok

```bash
ngrok http 3333
```

| Platform  | Webhook URL |
|-----------|-------------|
| WhatsApp  | `https://<ngrok-id>.ngrok.io/messaging/whatsapp/webhook` |
| Instagram | `https://<ngrok-id>.ngrok.io/messaging/instagram/webhook` |

Subscribe to the `messages` field for both products.

## Testing Web Chat

```bash
curl -X POST http://localhost:3333/api/chat/sse \
  -H "Content-Type: application/json" \
  -d '{"message": "Hello", "sessionId": "test-session"}'
```

## Offline proof

The **`same_bot_across_channels`** test in `@kuralle-agents/engagement` drives mock platforms and the composed engagement pipeline without live Meta or model calls:

```bash
bun test packages/engagement/test/same-bot-across-channels.test.ts
```

## How It Works

- **`whatsappPolicy` / `instagramPolicy` / `webPolicy`** implement `ChannelPolicy` (window model, closed-window strategy, `renderInteractive`, `resolveInbound`).
- **`createMessagingRouter`** appends terminal **`windowGuard`** after `bridge.outbound` (consent → ownership → closed-window recovery → interactive renderer).
- **`createKuralleChatRouter`** exposes the same **`runtime`** over HTTP/SSE for browser clients.
- Session IDs stay scoped per platform thread; the bot never branches on `platform`.
