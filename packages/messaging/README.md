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
- **`InboundLedger`** — async claim/append/complete ledger for tenant-scoped inbound idempotency and ordering.
- **`WindowTracker`** / **`WindowStore`** — tracks 24-hour messaging windows per thread; used by `createMessagingRouter` to detect expired windows.
- **`OutboundPipeline`** + **`windowGuard`** — window-safe outbound path (see below).
- **`createInputCoalescer`** + **`inboundCoalescing`** — optional per-thread burst coalescing before `runtime.run` (WhatsApp text-ins). Default **off**; see [Inbound coalescing](#inbound-coalescing).

### Window-safe outbound

Every outbound send — default `StreamMapper` text replies, custom `responseMapper` (`ResponseContext.sendText` / `sendInteractive` / `sendMedia`), and router `fallbackMessage` on runtime errors — traverses an `OutboundPipeline` with a non-removable, terminal `windowGuard` middleware. The driver reads `WindowStore.get(threadId)` once per send and sets `req.meta.window`; when the window is closed, free-form payloads (text, media, interactive) **defer** (`{ kind: 'deferred', reason: 'window-closed' }`) with zero client calls. Templates are window-agnostic and pass through.

`createMessagingRouter` accepts optional `windowStore` (default `InMemoryWindowStore`) and `outbound` (extra middleware installed **before** `windowGuard`). Custom `responseMapper` closures still return `Promise<SendResult>`; deferred sends resolve to a synthetic result with an empty `messageId` (not delivered).

`WhatsAppClient.sendTextOrTemplate` is **deprecated** — it bypasses this pipeline. Use `OutboundPipeline` / the router instead.

### Inbound coalescing

WhatsApp users often send bursts of short messages (`hi` / `i want to order` / `the blue one`). Without coalescing, each webhook becomes its own serialized turn. Enable burst merging on the router:

```typescript
const router = createMessagingRouter({
  runtime,
  platforms: { whatsapp },
  inboundCoalescing: {
    debounceMs: 3000,   // trailing debounce; 0 = off (pass-through)
    maxWaitMs: 10_000,  // hard cap from first buffered message
    maxMessages: 10,    // flush when buffer is full
  },
});
```

Defaults when `inboundCoalescing` is set: `debounceMs` **3000**, `maxWaitMs` **10000**, `maxMessages` **10**. Interactive selections (button/list taps) flush immediately — they are complete by construction. Each flushed batch becomes **one** `runtime.run` with a merged `UserInputContent` parts array in arrival order (image-then-caption → `[FilePart, TextPart]`).

Omit `inboundCoalescing` entirely for today's behavior (one message → one turn).

**Durable Objects:** v1 keeps the coalescer buffer in-memory on the router instance. In a DO deployment the DO *is* the thread, so the timer lives with the conversation. Process eviction can lose at most one un-flushed buffer; upgrade to `storage.setAlarm` for eviction-proof debounce (not implemented in v1).

Mid-turn messages queued while a turn is in flight are merged at admission in `@kuralle-agents/core` (`consumeAllPendingUserInput`) — pair both layers for burst UX on WhatsApp.

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

- [`@kuralle-agents/messaging-meta`](../messaging-meta) — WhatsApp, Messenger, and Instagram clients
- [`@kuralle-agents/core`](../core) — runtime, agents, flows
