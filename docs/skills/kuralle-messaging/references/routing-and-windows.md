# Routing, Windows, and Stream Buffering

## createMessagingRouter

Mounts all platforms on a single Hono router. Each platform gets its own webhook path. Meta's GET verification challenge is handled automatically.

```ts
import { createMessagingRouter } from '@kuralle-agents/messaging';

const router = createMessagingRouter({
  runtime,
  platforms: {
    whatsapp,    // POST /messaging/whatsapp/webhook
    messenger,   // POST /messaging/messenger/webhook
    instagram,   // POST /messaging/instagram/webhook
  },
});

app.route('/messaging', router);
```

### Options

| Field | Type | Description |
|-------|------|-------------|
| `runtime` | `Runtime` | Kuralle Runtime with your agents |
| `platforms` | `Record<string, PlatformClient>` | One entry per platform |
| `sessionResolver` | `SessionResolver` | Custom session ID mapping (see below) |
| `typingIndicatorIntervalMs` | `number` | Typing indicator frequency during stream. Default: 5000ms |

## Custom sessionResolver

Default session ID: `{platform}:{threadId}` (e.g., `whatsapp:+1234567890`).

Override to map to your own customer IDs:

```ts
const router = createMessagingRouter({
  runtime,
  platforms: { whatsapp },
  sessionResolver: {
    resolve: async (message) => {
      const customer = await db.customers.findByPhone(message.from.phone!);
      return {
        sessionId: `crm:${customer.id}`,
        userId: customer.id,          // for memory scoping
      };
    },
  },
});
```

The `message` object includes: `from.phone` (WhatsApp), `from.psid` (Messenger), `from.igsid` (Instagram), `platform`, `text`, `type`.

## 24-hour messaging window

WhatsApp and Instagram enforce a 24-hour window after the customer's last message. Outside the window, only pre-approved template messages are allowed. Messenger has no window restriction.

### WindowTracker behavior

- Records inbound timestamp on each user message: expiry = `timestamp + 24h`
- If Meta sends a `conversation.expirationTimestamp` in a status webhook, that overrides the computed value (more accurate)

### WindowClosedError

When you attempt `sendText()` outside the window, the SDK throws `WindowClosedError`. This is intentional — templates cost money and vary by country/category. The SDK makes the closed-window visible so your code decides what to do.

```ts
try {
  await whatsapp.sendText(to, 'Your session has expired. Reply to continue.');
} catch (err) {
  if (err instanceof WindowClosedError) {
    // Decide: send template, queue message, or drop
    await whatsapp.sendTemplate(to, { name: 'session_expired', language: { code: 'en' }, components: [] });
  }
}
```

### Automatic fallback with sendTextOrTemplate

```ts
await whatsapp.sendTextOrTemplate(to, {
  text: 'Your order has shipped!',
  fallbackTemplate: {
    name: 'order_shipped',
    language: { code: 'en' },
    components: [{ type: 'body', parameters: [{ type: 'text', text: 'ORD-12345' }] }],
  },
});
```

Use only when the template content is appropriate for automatic sending — this bypasses the `WindowClosedError` and sends the template immediately.

## Stream buffering — why text is batched

Messaging platforms have no message-edit API. Streaming 50 tokens as 50 separate messages is unusable. The `StreamMapper` accumulates all `text-delta` events and sends one message when the stream completes.

```
Runtime.stream() emitting text-delta events
  → StreamMapper accumulates into string
  → Sends typing indicator every 5s
  → Stream ends → sendText(to, completeText)
```

If the stream emits quick replies or buttons alongside text, `StreamMapper` sends those as a second message immediately after the text.

## MessageDeduplicator

Meta retries webhook deliveries when your server responds slowly or with a non-2xx status. The `MessageDeduplicator` tracks recently seen message IDs in memory and silently drops duplicates. This prevents the same user message from being processed twice and generating duplicate replies.

The deduplicator is always active inside `createMessagingRouter()`. If you're building a custom webhook handler, initialize it manually:

```ts
import { MessageDeduplicator } from '@kuralle-agents/messaging';

const deduplicator = new MessageDeduplicator({ ttlMs: 60_000 });

// In your webhook handler:
if (deduplicator.isDuplicate(message.id)) {
  return new Response('OK', { status: 200 }); // acknowledge silently
}
deduplicator.record(message.id);
```

## MediaCache

Media URLs from Meta are valid for ~5 minutes. The `MediaCache` prevents re-downloading the same attachment across multiple handlers or retry attempts.

```ts
import { MediaCache } from '@kuralle-agents/messaging';

const cache = new MediaCache({ maxEntries: 100, ttlMs: 300_000 }); // 5min TTL

const download = await cache.getOrDownload(mediaId, () =>
  platform.downloadMedia(mediaId)
);
```

`createMessagingRouter()` creates and manages the cache internally.
