# Pharmacy Rx Agent (Cloudflare Durable Objects)

A WhatsApp-style pharmacy ordering agent that demonstrates the two platform features
end-to-end: **multimodal intake** (a prescription image) and **durable human-in-the-loop
checkout** (a payment link that resumes the conversation). One Durable Object per chat
thread → multi-tenant isolation + persistent cart/history.

See [`WBS.md`](./WBS.md) for the full plan and current status.

## Flow

1. Customer sends a message + prescription image.
2. The model (vision) reads the prescription, calls `check_inventory` per medicine, and
   reports what's in stock + price; answers follow-up questions; manages a persistent cart.
3. On purchase confirmation, the `checkout` action mints a payment link and **suspends** on
   the durable `payment` signal.
4. Hitting `GET /pay/<token>` delivers the signal to the exact DO (`idFromString`), which
   **resumes** the run, finalizes the order, and broadcasts "✅ order completed" to the
   client (and persists it for reconnecting clients). Closing the chat mid-flow is safe —
   state lives in the DO.

## Layout

- `src/index.ts` — Worker entry: web chat (`PharmacyAgent` + `routeAgentRequest` + `/pay/:token`) **and** the WhatsApp webhook + `/wa-pay/:token` route.
- `src/pharmacy.ts` — flow (`assist → checkout → orderComplete`), cart, and global tools. Reused as-is by both channels.
- `src/inventory.ts` — demo inventory + matcher.
- `src/token.ts` — checkout-token codec (demo-grade base64url; sign it in prod).
- `src/wa-agent.ts` — `PharmacyWaAgent`: one Durable Object per WhatsApp user (tenant-scoped `wa:{phoneNumberId}:{from}`). Runs the shared `@kuralle-agents/messaging` inbound pipeline via `createDurableObjectInboundRuntime` (DO-SQLite ledger/stores + Cloudflare `agents` `TurnQueue`/`messageConcurrency`/`schedule`). Includes the `NormalizedMessage→InboundMessage` map + WhatsApp outbound formatter.
- `src/wa-session-store.ts` — DO-SQLite `SessionStore` (durable cart + checkout effect log).
  (The old hand-rolled `wa-turn.ts` is gone — dedup/coalescing/window/consent/turn now live in the shared pipeline.)
- `tools/live-chat.ts` — WS harness to drive a live chat turn.

## Deploy

```bash
cd apps/playground/pharmacy-rx-agent
wrangler secret put OPENAI_API_KEY          # vision-capable model key
wrangler deploy
# then set PUBLIC_URL in wrangler.jsonc to the deployed URL (for clickable links) and redeploy
```

Deployed: `https://pharmacy-rx-agent.mithushancj.workers.dev`.

## Chat UI

Open the deployed URL in a browser — `public/index.html` is a self-contained
(no-build) WhatsApp-style chat client served as a static asset:

- Attach a prescription photo (📎) — downscaled client-side and sent as a `file`
  part (data URL) for the vision model to read.
- Streams the reply token-by-token; renders the checkout link as a **Pay securely**
  button. Hitting it resumes the suspended checkout and the order-confirmation
  message is pushed back into the open chat live (CF broadcast), no reload.
- One Durable Object per thread; thread id persists in `localStorage`. "New chat"
  starts a fresh thread. History rehydrates on load via `GET …/get-messages`.

## WhatsApp channel

The **same agent** also runs on real WhatsApp via the Meta Cloud API — only the
I/O channel differs (no agent/flow code changes).

```
WhatsApp user → Meta Cloud API → POST /messaging/whatsapp/webhook
   → verifySignature (HMAC) → normalizeWebhook
   → per-user Durable Object  PharmacyWa.idFromName('wa:' + from)
       → SqlSessionStore (DO SQLite: durable cart + checkout effect log)
       → runtime.run(buildPharmacyAgent(...))   ← inbound image auto-downloaded → file part
       → WhatsAppClient.sendText(reply)
   ↺ /wa-pay/<token> → same DO → runtime.run(signalDelivery) → "✅ order confirmed" via WhatsApp
```

### Go live (one-time Meta setup)

1. Create a **Meta Developer app** → add the **WhatsApp** product → use the free
   **test number** (or add your own business number).
2. Set the five secrets (the verify token is any string you choose):

   ```bash
   wrangler secret put WHATSAPP_ACCESS_TOKEN      # WhatsApp → API Setup → temporary/system-user token
   wrangler secret put WHATSAPP_APP_SECRET        # App Settings → Basic → App Secret
   wrangler secret put WHATSAPP_PHONE_NUMBER_ID   # WhatsApp → API Setup → Phone number ID
   wrangler secret put WHATSAPP_VERIFY_TOKEN      # any string; you'll paste the same value into Meta
   wrangler deploy
   ```

3. In the Meta dashboard → WhatsApp → Configuration → **Webhook**:
   - Callback URL: `https://pharmacy-rx-agent.mithushancj.workers.dev/messaging/whatsapp/webhook`
   - Verify token: the same `WHATSAPP_VERIFY_TOKEN` value
   - Subscribe to the **`messages`** field.
4. In **API Setup**, add your phone as a test recipient, then message the test
   number a prescription photo. (`WHATSAPP_WABA_ID` is only needed if you later
   add templates for re-engagement outside the 24-hour window.)

> The temporary access token expires in ~24h; generate a **system-user token** for
> anything beyond a quick trial. Replies outside the 24-hour customer-service
> window require an approved **template** (not wired in this demo — within-window
> replies, including the payment confirmation, work without one).

### Verified

- Offline (`bun test src/wa.test.ts`): HMAC verify, webhook normalize, image →
  `file` part, DO-SQLite session round-trip (incl. durable run journal), token codec.
- Live (no Meta needed): webhook handshake echoes the challenge (200), wrong token
  → 403, unsigned POST → 401.
- The agent's image-reading, checkout, and payment-resume behavior is the same code
  proven by the web client above.

## Test

```bash
# headless WS harness: multimodal intake + inventory
bun run tools/live-chat.ts tenant-A "Here's my Rx. I need Amoxicillin 500mg + Metformin 500mg." <imageUrl>
# follow-up + checkout in the same thread, then hit the emitted /pay/<token> link
```

Wire protocol (for custom clients): connect a WS to
`/agents/pharmacy-agent/<thread>`, send a `cf_agent_use_chat_request` frame whose
`init.body` is `{ id, messages, trigger: 'submit-message' }`; the reply streams as
`cf_agent_use_chat_response` frames (one AI-SDK chunk per `body`, `done:true` ends).
Broadcasts (`cf_agent_chat_messages`, full list) reach *other* connections — which is
how the out-of-band `/pay` resume surfaces in the chat.
