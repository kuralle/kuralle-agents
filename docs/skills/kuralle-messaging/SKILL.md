---
name: kuralle-messaging
description: Connect Kuralle agents to messaging platforms — WhatsApp, Messenger, Instagram, and future channels. Use this skill whenever the user wants to integrate with WhatsApp, Facebook Messenger, Instagram DMs, or any Meta messaging platform; set up webhook handlers; handle 24-hour messaging windows or template messages; build multi-platform bots; handle media attachments; implement message deduplication or webhook security. Trigger on any mention of: WhatsApp, Messenger, Instagram, Meta messaging, webhook, template message, 24-hour window, messaging channel, platform client, messaging SDK.
---

# Kuralle Messaging

Use this skill when connecting a Kuralle agent to WhatsApp, Messenger, Instagram, or building multi-platform messaging bots.

## Read this first

- **Two packages**: `@kuralle-agents/messaging` (core adapter, zero vendor deps) + `@kuralle-agents/messaging-meta` (WhatsApp/Messenger/Instagram).
- **`createMessagingRouter()` mounts all platforms on one Hono app** — one route per platform.
- **The SDK buffers stream output** — messaging platforms don't support message editing. All `text-delta` events merge into one final message.
- **Never silently fall back to templates** — `WindowClosedError` is thrown instead. Templates cost money and need pre-approval.
- **Webhook signatures are always verified** — HMAC-SHA256 timing-safe comparison.

## Install

```bash
bun add @kuralle-agents/messaging @kuralle-agents/messaging-meta
```

## Multi-platform (all three at once)

```ts
import { Hono } from 'hono';
import { createMessagingRouter } from '@kuralle-agents/messaging';
import { createWhatsAppClient } from '@kuralle-agents/messaging-meta/whatsapp';
import { createMessengerClient } from '@kuralle-agents/messaging-meta/messenger';
import { createInstagramClient } from '@kuralle-agents/messaging-meta/instagram';
import { Runtime } from '@kuralle-agents/core';

const runtime = new Runtime({ agents: [myAgent], defaultAgentId: myAgent.id });

const whatsapp = createWhatsAppClient({
  accessToken: process.env.WHATSAPP_ACCESS_TOKEN!,
  appSecret: process.env.META_APP_SECRET!,
  phoneNumberId: process.env.WHATSAPP_PHONE_NUMBER_ID!,
  verifyToken: process.env.WHATSAPP_VERIFY_TOKEN!,
});

const messenger = createMessengerClient({
  pageAccessToken: process.env.MESSENGER_PAGE_ACCESS_TOKEN!,
  appSecret: process.env.META_APP_SECRET!,
  pageId: process.env.MESSENGER_PAGE_ID!,
  verifyToken: process.env.MESSENGER_VERIFY_TOKEN!,
});

const instagram = createInstagramClient({
  accessToken: process.env.INSTAGRAM_ACCESS_TOKEN!,
  appSecret: process.env.META_APP_SECRET!,
  igId: process.env.INSTAGRAM_ACCOUNT_ID!,
  verifyToken: process.env.INSTAGRAM_VERIFY_TOKEN!,
});

const router = createMessagingRouter({ runtime, platforms: { whatsapp, messenger, instagram } });
const app = new Hono();
app.route('/messaging', router);
// Mounts:
//   POST /messaging/whatsapp/webhook
//   POST /messaging/messenger/webhook
//   POST /messaging/instagram/webhook
```

## Navigation

- `references/platform-setup.md` — per-platform setup, templates, interactive messages, platform-specific APIs
- `references/routing-and-windows.md` — createMessagingRouter, sessionResolver, 24h window handling, stream buffering

Rules:
- `rules/window-policy.md` — 24-hour window and template message rules

## Platform differences

| Platform | Base URL | Media | Interactive | Window |
|----------|----------|-------|-------------|--------|
| WhatsApp | graph.facebook.com | All types | Buttons, lists | 24h free-form |
| Messenger | graph.facebook.com | All types | Button templates, quick replies | No window |
| Instagram | **graph.instagram.com** | Images only | Limited | 24h free-form (HUMAN_AGENT = 7 days) |

Instagram uses a different base URL — this is a historical artifact and handled automatically by the SDK.

## How a message flows through the SDK

```
User sends WhatsApp message
  → POST /whatsapp/webhook
  → HMAC-SHA256 signature verified
  → MessageDeduplicator: reject retries
  → WindowTracker: record inbound, set expiry = now + 24h
  → SessionResolver: map threadId → Kuralle sessionId
  → runtime.stream({ input, sessionId })
  → StreamMapper: buffer all text-delta events → single message
  → Typing indicator sent every 5s during buffering
  → whatsapp.sendText(to, completeText)
```

Streaming tokens are never sent individually — messaging platforms have no edit API.

## Custom session resolver

Map phone numbers or PSIDs to your own customer IDs:

```ts
const router = createMessagingRouter({
  runtime,
  platforms: { whatsapp },
  sessionResolver: {
    resolve: async (message) => {
      const customer = await db.customers.findByPhone(message.from.phone!);
      return { sessionId: `crm:${customer.id}`, userId: customer.id };
    },
  },
});
```

## Non-negotiables

- Always call `analytics.flush()` or `await server.close()` before process exit — in-flight webhooks may still be processing.
- Never catch and swallow `WindowClosedError` silently — surface it so the application can decide whether to send a template.
- Platform webhooks must return 200 quickly (within 20s) or Meta retries. The `MessageDeduplicator` handles the retry; make sure it is always active.
- For tenant isolation, use `staticFilter` in RAG tools + a custom `sessionResolver` that maps to per-tenant session namespaces.
