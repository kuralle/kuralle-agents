# Messaging Platform Setup

## WhatsApp

```ts
import { createWhatsAppClient } from '@kuralle-agents/messaging-meta/whatsapp';

const whatsapp = createWhatsAppClient({
  accessToken: process.env.WHATSAPP_ACCESS_TOKEN!,
  appSecret: process.env.META_APP_SECRET!,
  phoneNumberId: process.env.WHATSAPP_PHONE_NUMBER_ID!,
  verifyToken: process.env.WHATSAPP_VERIFY_TOKEN!,
});
```

### Template messages

Templates are the only free-form message type allowed outside the 24-hour window. Must be pre-approved by Meta before use.

```ts
await whatsapp.sendTemplate('+1234567890', {
  name: 'order_update',
  language: { code: 'en' },
  components: [
    { type: 'body', parameters: [{ type: 'text', text: 'ORD-12345' }] },
  ],
});
```

### Interactive messages

```ts
// Buttons (up to 3)
await whatsapp.sendInteractiveButtons('+1234567890', {
  body: { text: 'How can we help?' },
  buttons: [
    { id: 'track_order', title: 'Track order' },
    { id: 'talk_to_human', title: 'Talk to a human' },
  ],
});

// List (up to 10 items)
await whatsapp.sendInteractiveList('+1234567890', {
  body: { text: 'Choose a topic:' },
  button: 'Select',
  sections: [{
    title: 'Support',
    rows: [
      { id: 'billing', title: 'Billing', description: 'Payments and invoices' },
      { id: 'technical', title: 'Technical', description: 'Bugs and issues' },
    ],
  }],
});
```

### 24-hour window (automatic fallback)

```ts
await whatsapp.sendTextOrTemplate('+1234567890', {
  text: 'Your order has shipped!',
  fallbackTemplate: {
    name: 'order_shipped',
    language: { code: 'en' },
    components: [
      { type: 'body', parameters: [{ type: 'text', text: 'ORD-12345' }] },
    ],
  },
});
```

Sends text if the window is open. Falls back to the template if `WindowClosedError` would be thrown. Use this only when you are certain the template content is appropriate for automated sending.

---

## Messenger

```ts
import { createMessengerClient } from '@kuralle-agents/messaging-meta/messenger';

const messenger = createMessengerClient({
  pageAccessToken: process.env.MESSENGER_PAGE_ACCESS_TOKEN!,
  appSecret: process.env.META_APP_SECRET!,
  pageId: process.env.MESSENGER_PAGE_ID!,
  verifyToken: process.env.MESSENGER_VERIFY_TOKEN!,
});
```

### Button template

```ts
await messenger.sendButtonTemplate(recipientPsid, {
  text: 'What would you like to do?',
  buttons: [
    { type: 'postback', title: 'Check status', payload: 'CHECK_STATUS' },
    { type: 'web_url', title: 'Visit website', url: 'https://example.com' },
  ],
});
```

### Quick replies

```ts
await messenger.sendQuickReplies(recipientPsid, 'Pick a category:', [
  { content_type: 'text', title: 'Sales', payload: 'SALES' },
  { content_type: 'text', title: 'Support', payload: 'SUPPORT' },
]);
```

### Persona API (respond as a named human agent)

```ts
const persona = await messenger.personas.create({
  name: 'Alex from Support',
  profile_picture_url: 'https://example.com/alex.jpg',
});

await messenger.sendRaw(recipientPsid, {
  message: { text: 'Hi, I am Alex. How can I help?' },
  persona_id: persona.id,
});
```

### Postback vs interactive

When a user taps a button on Messenger, it arrives as a `postback` event (not `interactive`). The webhook normalizer handles this — your `onMessage` handler receives a unified `NormalizedMessage` regardless.

---

## Instagram

Instagram uses `graph.instagram.com` as the base URL (not `graph.facebook.com`). This is handled automatically.

**Limitations:** Images only (no video/audio/document). 1000-byte UTF-8 text limit per message.

```ts
import { createInstagramClient } from '@kuralle-agents/messaging-meta/instagram';

const instagram = createInstagramClient({
  accessToken: process.env.INSTAGRAM_ACCESS_TOKEN!,
  appSecret: process.env.META_APP_SECRET!,
  igId: process.env.INSTAGRAM_ACCOUNT_ID!,
  verifyToken: process.env.INSTAGRAM_VERIFY_TOKEN!,
});
```

### Ice breakers (conversation starters)

```ts
await instagram.iceBreakers.set([
  { question: 'What are your hours?', payload: 'HOURS' },
  { question: 'Track my order', payload: 'TRACK_ORDER' },
]);
```

Shown the first time a user opens a DM thread. Tapping one sends the payload as a message.

### Private replies (reply to a comment)

```ts
await instagram.sendPrivateReply({
  commentId: '17858893269xxxxxx',
  text: 'Thanks for your comment! Check your DMs for details.',
});
```

### HUMAN_AGENT tag (extends window to 7 days)

Instagram normally has a 24-hour window. The `HUMAN_AGENT` tag extends it to 7 days for follow-up by a human agent:

```ts
await instagram.sendTextWithTag(
  recipientIgsid,
  'A human agent will follow up within 24 hours.',
  'HUMAN_AGENT',
);
```

---

## Standalone webhook verification

If building a custom setup outside `createMessagingRouter()`:

```ts
import { verifySignature } from '@kuralle-agents/messaging-meta';

const valid = verifySignature({
  appSecret: process.env.META_APP_SECRET!,
  rawBody: requestBody,           // Buffer or string
  signatureHeader: request.headers.get('x-hub-signature-256') ?? '',
});

if (!valid) return new Response('Invalid signature', { status: 403 });
```

Uses `crypto.timingSafeEqual` to prevent timing attacks.
