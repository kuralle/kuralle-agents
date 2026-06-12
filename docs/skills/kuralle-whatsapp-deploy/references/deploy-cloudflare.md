# Deploy a WhatsApp bot on Cloudflare Workers

This is the path to recommend when the bot has a **durable, human-in-the-loop step** (payment link, approval, anything that suspends and resumes later) — Cloudflare Durable Objects give you per-user isolation and a free durable store with zero external database.

## The shape

- A **Worker fetch handler** verifies the Meta webhook, normalizes it, and fans each inbound message out to a **per-user Durable Object** keyed by `idFromName('wa:' + from)`.
- Each **Durable Object** holds that user's session in **DO SQLite** (a tiny JSON-blob `SessionStore`) and runs your agent through `createRuntime`. Inbound images are downloaded → `file` part for the vision model. Replies go back via `WhatsAppClient.sendText`.
- A **`/wa-pay/<token>`** route resumes a suspended checkout by delivering the durable signal, then pushes the confirmation over WhatsApp.

```
POST /messaging/whatsapp/webhook
  → verifySignature → normalizeWebhook
  → PharmacyWa.idFromName('wa:' + from).fetch('/whatsapp')
      → SqlSessionStore (DO SQLite: cart + durable effect log)
      → runtime.run(yourAgent)  →  WhatsAppClient.sendText
  ↺ /wa-pay/<token> → same DO → runtime.run({ signalDelivery }) → "✅ done" via WhatsApp
```

## Why this is durable without a database

The runtime stores the run state **and** the exactly-once effect log inside the Session object (`session.durableRuns`, a plain JSON key). So persisting the Session persists everything needed for suspend/resume + idempotent retries. DO SQLite is that persistence. A re-clicked payment link is safe — the effect log dedupes it.

## Files to copy (in `assets/templates/cloudflare/`)

| File | What it is |
|---|---|
| `wa-session-store.ts` | `SqlSessionStore` — DO-SQLite `SessionStore` that JSON-serializes the Session and revives `Date` fields on read. **Reusable verbatim.** |
| `wa-turn.ts` | Channel I/O: `buildWhatsAppInput` (image → `file` part), `runWhatsAppTurn`, `resumeWhatsAppPayment`. Pure functions → unit-testable with a fake client. |
| `wa-agent.ts` | `PharmacyWaAgent` Durable Object: wires `createRuntime(yourAgent)` + `createWhatsAppClient` to the turn logic. **Rename + swap in your own agent.** |
| `webhook-routes.snippet.ts` | The Worker fetch-handler routes (GET verify / POST inbound / `/wa-pay`). |
| `wrangler.snippet.jsonc` | The DO binding + SQLite migration + the secrets list. |

## Adapt it to your agent

1. Replace `buildPharmacyAgent(...)` in `wa-agent.ts` with your own `defineAgent`/builder. Keep the `createRuntime({ agents, defaultAgentId, sessionStore: new SqlSessionStore(this.ctx.storage.sql) })` shape.
2. If your agent has a durable suspend step that an external link resumes (like checkout), keep `resumeWhatsAppPayment` + the `/wa-pay` route. If it doesn't, delete both — the inbound turn path is all you need.
3. Rename the DO class consistently across `wa-agent.ts`, the `export { … }` in your entry, and `wrangler.jsonc`.

`wa-turn.ts` deliberately depends only on a narrow `WhatsAppSender` interface (`sendText` + `downloadMedia`), so you can unit-test the whole turn — including image intake and resume — with a fake client and no live Meta. Do that; it's the cheapest confidence you'll get.

## Deploy

```bash
# 1) set secrets (NOT vars)
echo "<key>"   | npx wrangler secret put OPENAI_API_KEY
echo "<token>" | npx wrangler secret put WHATSAPP_ACCESS_TOKEN
echo "<secret>"| npx wrangler secret put WHATSAPP_APP_SECRET
echo "<id>"    | npx wrangler secret put WHATSAPP_PHONE_NUMBER_ID
echo "<verify>"| npx wrangler secret put WHATSAPP_VERIFY_TOKEN

# 2) deploy (applies the DO migration)
npx wrangler deploy

# 3) prove the webhook handshake live, before opening Meta
curl "https://<worker>.workers.dev/messaging/whatsapp/webhook?hub.mode=subscribe&hub.verify_token=<verify>&hub.challenge=ok"
# → ok
```

Run wrangler from the worker directory (these CLIs error if run from inside a monorepo package root other than the app's own).

## Gotchas specific to CF

- **`ctx.waitUntil` for the turn, 200 immediately.** Running the model inside the webhook request risks Meta's retry timeout → duplicate messages. The snippet returns 200 fast and runs the turn in the background.
- **`new_sqlite_classes` (not `new_classes`).** The session store needs SQLite-backed DOs. Bump the migration `tag` if you already have migrations.
- **The DO class must be exported from the Worker's entry module**, or wrangler can't bind it.
- **Static assets** (a web chat UI, privacy page, icon) can live in `public/` alongside this — CF serves them and the Worker handles the dynamic routes.
