# @kuralle-agents/messaging

Core interfaces and Hono router adapter for connecting messaging platforms to the Kuralle runtime.

## Install

```bash
npm install @kuralle-agents/messaging
```

## What it does

Provides the `PlatformClient` interface that every messaging vendor package implements, and `createMessagingRouter` that wires platform clients to a Kuralle `Runtime` over a Hono router.

- **`createMessagingRouter`** — creates a Hono router with webhook endpoints for each platform. Routes inbound messages to a `Runtime` turn, streams responses back as text or interactive messages, and handles deduplication and messaging window tracking automatically.
- **`PlatformClient`** — interface that normalizes sending, receiving, media, webhooks, and format conversion across vendors. Implement this to add any messaging platform.
- **`SessionResolver`** — maps inbound messages to Kuralle session IDs. Default: `{platform}:{threadId}`. Swap in `ThreadIdResolver`, `PhoneLookupResolver`, or a custom `SessionResolverChain`.
- **`StreamMapper`** — consumes `AsyncIterable<HarnessStreamPart>`, sends typing indicators during streaming, delegates final output to a `ResponseMapper`.
- **`MessageDeduplicator`** — LRU cache that prevents duplicate webhook processing.
- **`WindowTracker`** — tracks 24-hour messaging windows per thread; used by `createMessagingRouter` to detect expired windows.
- Error classes: `MessagingError`, `RateLimitError` (with `retryAfterMs`), `WindowClosedError` (with `suggestedTemplates`), `AuthenticationError`, `PermissionError`, `RecipientError`, `TemplateError`, `MediaError`, `WebhookVerificationError`.

## Usage

```typescript
import { Hono } from 'hono';
import { createRuntime, defineAgent } from '@kuralle-agents/core';
import { createMessagingRouter } from '@kuralle-agents/messaging';
import { createWhatsAppClient } from '@kuralle-agents/messaging-meta/whatsapp';

const runtime = createRuntime({
  agents: [defineAgent({ id: 'support', instructions: 'You are a support agent.' })],
  defaultAgentId: 'support',
});

const whatsapp = createWhatsAppClient({
  accessToken: process.env.WHATSAPP_ACCESS_TOKEN!,
  appSecret: process.env.META_APP_SECRET!,
  phoneNumberId: process.env.WHATSAPP_PHONE_NUMBER_ID!,
  verifyToken: process.env.WHATSAPP_VERIFY_TOKEN!,
});

const router = createMessagingRouter({ runtime, platforms: { whatsapp } });

const app = new Hono();
app.route('/messaging', router);
// Webhook: POST /messaging/whatsapp/webhook
```

### Error handling

```typescript
import { RateLimitError, WindowClosedError } from '@kuralle-agents/messaging';

try {
  await client.sendText(to, text);
} catch (e) {
  if (e instanceof RateLimitError) await sleep(e.retryAfterMs);
  if (e instanceof WindowClosedError) { /* send a template instead */ }
}
```

## Related

- [`@kuralle-agents/messaging-meta`](../kuralle-messaging-meta) — WhatsApp, Messenger, and Instagram clients
- [`@kuralle-agents/core`](../kuralle-core) — runtime, agents, flows
