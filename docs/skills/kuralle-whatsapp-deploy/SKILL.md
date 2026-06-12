---
name: kuralle-whatsapp-deploy
description: Ship a Kuralle agent to real WhatsApp end-to-end — set up the Meta/WhatsApp Cloud API account, get the credentials, deploy the bot (Cloudflare Workers, Fly.io, or Vercel), connect the webhook, test it, and take it live. Use this skill whenever the user wants to "put my bot on WhatsApp", "deploy a WhatsApp bot", "go live on WhatsApp", "set up WhatsApp Cloud API", "get a WhatsApp access token", "connect the Meta webhook", "publish my Meta app", "WhatsApp business verification", "host my agent on Cloudflare/Fly/Vercel", or asks why their WhatsApp bot isn't receiving/replying. This is the production/deployment + account-setup companion to the `kuralle-messaging` skill (which covers the SDK itself) — reach for this one the moment the goal is getting a working bot into a real person's WhatsApp, not just writing the agent code.
---

# Shipping a Kuralle agent to real WhatsApp

This is the "we actually did it, here's how it goes" guide. The agent code is the easy part — the friction is the Meta account dance and picking the right place to host. This skill walks the whole thing, calls out the parts that *will* trip you up, and bundles the proven Cloudflare wiring you can copy.

Talk to the user like a colleague who's done this before: warm, concrete, honest about the annoying bits. Don't dump all four reference files on them — figure out where they are and meet them there.

## The mental model (read this first)

Your agent is just a `defineAgent(...)` / `buildXAgent()` that returns an `AgentConfig`. **It does not change** when you add WhatsApp — you only add an I/O channel around it:

```
WhatsApp user → Meta Cloud API → POST /messaging/whatsapp/webhook
   → verify HMAC signature → normalize the payload
   → runtime.run({ input, sessionId })      ← your agent, unchanged
   → send the reply back via the Graph API
```

Two truths that shape every decision below:

1. **Inbound images "just work."** `createMessagingRouter` (and the CF wiring here) downloads any inbound photo from Meta's CDN and attaches it as an AI-SDK `file` part — so a vision model reads a prescription/receipt/whatever with zero extra code.
2. **WhatsApp can't edit messages**, so the SDK buffers a turn and sends ONE final message. Streaming is invisible to the user; that's expected.

For the SDK details (routing, the 24-hour window, templates, interactive buttons, media), lean on the **`kuralle-messaging`** skill. This skill is about everything *around* the code: accounts, hosting, going live.

## Step 0 — What you need before touching code

- A **Meta Developer account** + an **app** with the **WhatsApp** product added. The free **test number** is enough to build the whole thing.
- A **model API key** (OpenAI / Google / xAI).
- A place to host (decide below).

The full click-path — creating the app, finding each credential, the webhook screen, and going live — is in **`references/meta-account-setup.md`**. Read it with the user; it's the part that actually costs them time.

The five things you'll end up with (memorize these names — they're the env vars everywhere):

| Env var | Where it comes from | Gotcha |
|---|---|---|
| `WHATSAPP_ACCESS_TOKEN` | WhatsApp → API Setup | The default one **expires in ~24h**. Make a System User token for anything real. |
| `WHATSAPP_PHONE_NUMBER_ID` | WhatsApp → API Setup | This is the *number ID*, not the phone number. |
| `WHATSAPP_APP_SECRET` | App Settings → Basic | Used to verify webhook signatures. Without it, inbound POSTs are rejected. |
| `WHATSAPP_VERIFY_TOKEN` | **You invent it** | Any string. You paste the same value into Meta's webhook screen. |
| `WHATSAPP_WABA_ID` | WhatsApp → API Setup | Only needed if you use templates (re-engagement outside 24h). |

Sanity-check the credentials before deploying anything — this catches a bad/expired token in 2 seconds instead of 20 confused minutes:

```bash
curl -s "https://graph.facebook.com/v24.0/<PHONE_NUMBER_ID>?fields=verified_name,display_phone_number&access_token=<ACCESS_TOKEN>"
# → {"verified_name":"...","display_phone_number":"+...","id":"..."}  means you're good
```

## Step 1 — Pick where to host

Ask the user; don't assume. The honest tradeoff:

| Target | Pick it when | Durable checkout (suspend/resume, exactly-once)? |
|---|---|---|
| **Cloudflare Workers** | You want edge + per-user isolation + zero external DB. **Best for durable, human-in-the-loop flows** (payment links, approvals). | ✅ Built in via Durable Object SQLite. |
| **Fly.io** | You want a normal always-… *no* — a spike-test box. Plain Node/Bun server, simplest mental model, the framework's paved path. | ✅ if you point the session store at Redis/Postgres; ⚠️ in-memory store loses state on restart. |
| **Vercel** | You already live on Vercel / want serverless functions next to a Next.js app. | ⚠️ No Durable Objects — needs an external durable session store (Upstash Redis or Postgres). |

Then open the matching reference and follow it:

- **`references/deploy-cloudflare.md`** — per-user Durable Object + DO-SQLite session store + webhook fan-out + the durable payment-resume route. Proven, copy-paste templates in `assets/templates/cloudflare/`.
- **`references/deploy-fly.md`** — the `whatsapp-server` Node/Bun pattern (`createMessagingRouter` + `engagement`), with a spike-test `fly.toml`.
- **`references/deploy-vercel.md`** — the same Hono app as a Vercel function, plus the external-session-store change you must make.

> **Durability is just a durable SessionStore.** The framework stores the run state + the exactly-once effect log *inside the Session* (`session.durableRuns`). So "does suspend/resume survive a restart?" reduces to "is my SessionStore durable?" On CF that's DO SQLite (free, built in); on Fly/Vercel it's Redis/Postgres.

## Step 2 — Connect the webhook in Meta

Once the bot is deployed and the URL is live:

1. Meta dashboard → WhatsApp → **Configuration → Webhook**.
2. **Callback URL**: `https://<your-host>/messaging/whatsapp/webhook`
3. **Verify token**: the exact value of your `WHATSAPP_VERIFY_TOKEN`.
4. Click **Verify and save** (Meta GETs the URL and expects the challenge echoed — the deploy templates handle this).
5. In the fields list, **subscribe to `messages`**.

You can confirm the handshake yourself before even opening Meta:

```bash
curl "https://<host>/messaging/whatsapp/webhook?hub.mode=subscribe&hub.verify_token=<VERIFY_TOKEN>&hub.challenge=hello"
# → echoes: hello
```

## Step 3 — Test it (you do NOT need to publish for this)

While the app is unpublished/in development mode, Meta only delivers messages from **numbers you've added as testers**:

- WhatsApp → API Setup → **"To" → Manage phone number list** → add your own phone (up to 5).
- Message the test number. The bot should reply.

This is the right place to stop and verify end-to-end **before** the business-verification slog.

## Step 4 — Go live (only when you want strangers to message it)

For a demo with known phones, **you can skip this entirely.** To open it to anyone:

- Add a **Privacy Policy URL** (mandatory), an **app icon** (1024×1024), and a **Category** in App Settings → Basic.
- Complete **Business Verification** (the slow part — needs business docs).
- Swap the temp token for a **permanent System User token**.
- Flip **App Mode: Development → Live**.

Details + the privacy-policy and icon shortcuts are in `references/meta-account-setup.md`.

## The gotchas that actually bite (say these out loud to the user)

- **The `EAAB…`/`EAAL…` token expires in ~24 hours.** Sends start failing with an auth error (code 190) and the bot goes silent. Fix = System User token with "Never" expiry. This is the #1 "it worked yesterday" cause.
- **Replies only work inside the 24-hour customer-service window.** Within it (someone messaged you recently), free text is fine — including a payment confirmation seconds later. Outside it, you need an **approved template**. Don't silently fall back to templates; they cost money and need approval.
- **App secret must match**, or every inbound webhook is a 401. If inbound goes quiet, check this first.
- **Phone Number ID ≠ phone number.** Easy to paste the wrong one.
- **Unpublished apps only talk to test recipients.** "Why doesn't my friend's message arrive?" → they're not on the tester list (or you haven't published).

## A note on secrets

Never commit real tokens. Put them in `.env` (gitignored) for reference and set them on the host as secrets:

- **Cloudflare**: `echo "<value>" | npx wrangler secret put WHATSAPP_ACCESS_TOKEN`
- **Fly**: `fly secrets set WHATSAPP_ACCESS_TOKEN=<value>`
- **Vercel**: `vercel env add WHATSAPP_ACCESS_TOKEN`

Treat any token pasted into a chat as compromised — rotate it before production.
