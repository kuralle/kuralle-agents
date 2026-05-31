# Multi-Platform Agent Example

A single Kuralle Runtime serving WhatsApp, Messenger, and web chat simultaneously. All three channels share the same agents, session store, and conversation logic.

## Architecture

```
                         ┌──────────────────────────┐
  WhatsApp user ──────>  │  /messaging/whatsapp/webhook  │──┐
                         └──────────────────────────┘   │
                         ┌──────────────────────────┐   │   ┌──────────┐
  Messenger user ─────>  │ /messaging/messenger/webhook │──┼──>│  Runtime  │
                         └──────────────────────────┘   │   │ (shared)  │
                         ┌──────────────────────────┐   │   └──────────┘
  Browser user ────────> │      /api/chat/sse        │──┘
                         └──────────────────────────┘
```

One `Runtime` instance. One `MemoryStore`. Three entry points.

## Prerequisites

1. A **Meta Developer Account** with a registered app
2. A **WhatsApp Business** phone number (Cloud API)
3. A **Facebook Page** with Messenger enabled
4. **ngrok** (or similar) for local webhook forwarding

## Environment Variables

```bash
# WhatsApp Cloud API
WHATSAPP_ACCESS_TOKEN=        # System user or temporary token
WHATSAPP_APP_SECRET=          # App secret from Meta dashboard
WHATSAPP_PHONE_NUMBER_ID=     # Phone number ID (not the phone number itself)
WHATSAPP_VERIFY_TOKEN=        # Any string you choose for webhook verification

# Messenger Platform
MESSENGER_PAGE_ACCESS_TOKEN=  # Page access token from Meta dashboard
MESSENGER_APP_SECRET=         # App secret (can be the same Meta app)
MESSENGER_PAGE_ID=            # Facebook Page ID
MESSENGER_VERIFY_TOKEN=       # Any string you choose for webhook verification

# OpenAI (for the support agent)
OPENAI_API_KEY=

# Optional
PORT=3333
```

## Running

```bash
# Install dependencies (from repo root)
bun install

# Start the server
npx tsx examples/multi-platform/server.ts
```

## Webhook Setup with ngrok

Meta requires HTTPS endpoints for webhooks. Use ngrok to expose your local server:

```bash
ngrok http 3333
```

Then configure the webhook URLs in the Meta Developer Dashboard:

| Platform  | Webhook URL                                        |
|-----------|----------------------------------------------------|
| WhatsApp  | `https://<ngrok-id>.ngrok.io/messaging/whatsapp/webhook`  |
| Messenger | `https://<ngrok-id>.ngrok.io/messaging/messenger/webhook` |

Subscribe to the `messages` field for both products.

## Testing Web Chat

The SSE endpoint works with any HTTP client:

```bash
curl -X POST http://localhost:3333/api/chat/sse \
  -H "Content-Type: application/json" \
  -d '{"message": "Hello", "sessionId": "test-session"}'
```

## How It Works

- `createWhatsAppClient` and `createMessengerClient` handle platform-specific webhook verification, signature checks, message normalization, and outbound delivery.
- `createMessagingRouter` wires both clients to the shared `Runtime`. When a message arrives, it normalizes the input, calls `runtime.run()`, and maps events from `handle.events` back through the originating platform client.
- `createKuralleChatRouter` exposes the same `Runtime` over HTTP/SSE for browser clients.
- The `Runtime` does not know or care which channel a message came from. Session IDs are scoped per platform thread (e.g., `whatsapp:<phoneNumberId>:<userPhone>`), so conversations stay isolated.
