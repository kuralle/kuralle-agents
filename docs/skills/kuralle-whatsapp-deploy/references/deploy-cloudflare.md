# Deploy a WhatsApp bot on Cloudflare Workers

Recommended when the bot has a **durable, human-in-the-loop step** (payment link, approval) — Durable Objects give per-user isolation and a free durable store with no external database. The DO runs the **shared `@kuralle-agents/messaging` inbound pipeline** and is **Cloudflare-native**: it adopts Cloudflare `agents`' own `TurnQueue` (serialization), `messageConcurrency` (merge/debounce), and `Agent.schedule()` alarms rather than hand-rolling them.

## The shape

- A **Worker fetch handler** verifies the Meta webhook, normalizes it, and fans each message out to a **per-user Durable Object** keyed **tenant-scoped**: `idFromName('wa:{phoneNumberId}:{from}')` (so the same customer under two business numbers stays isolated).
- Each **Durable Object** builds an `InboundRuntime` over DO-SQLite (`createDurableObjectInboundRuntime`) and runs the shared `createInboundPipeline([...])`. You get **dedup, ordering, window-guard, consent/STOP, coalescing, status/reaction/error handling for free** — the pipeline owns them.
- **`/wa-pay/<token>`** appends a durable `signal` event → resumes the suspended checkout → pushes the confirmation over WhatsApp.

```
POST /messaging/whatsapp/webhook
  → verifySignature → normalizeWebhook
  → PharmacyWa.idFromName('wa:{phoneNumberId}:{from}').fetch('/whatsapp')
      → createInboundPipeline([ claimAndAppend → statusReactionErrorPhase →
          recordWindow → consentStop → resolveAndAttachMedia → runTurn ])
        over createDurableObjectInboundRuntime (DO-SQLite ledger/stores +
        CF TurnQueue + messageConcurrency debounce + Agent.schedule alarms)
      → WhatsAppOutboundSender.send  (markdown → WhatsApp formatting)
  ↺ /wa-pay/<token> → same DO → signal event → resume → "✅ confirmed" via WhatsApp
```

## Why this is durable + production-safe without a database

- The runtime stores run state + the exactly-once effect log inside the Session (`session.durableRuns`), persisted by `SqlSessionStore` (DO SQLite). Suspend/resume + idempotent retries come for free.
- The **`InboundLedger`** (DO-SQLite) gives **atomic claim** (`claimed | duplicate | in_progress`): a Meta at-least-once retry or a re-clicked `/wa-pay` is a no-op — exactly-once inbound.
- **Cloudflare's `agents` primitives do the concurrency**: `TurnQueue` serializes turns per user; `messageConcurrency` (e.g. `{strategy:'debounce', debounceMs:50}`) merges a burst into one turn; `Agent.schedule()` backs any timed work. We do **not** ship a parallel scheduler — don't fight the platform.

## Files to copy (in `assets/templates/cloudflare/`)

| File | What it is |
|---|---|
| `wa-agent.ts` | `PharmacyWaAgent` Durable Object: builds `createDurableObjectInboundRuntime` (DO-SQLite + CF `TurnQueue`/`messageConcurrency`) + runs `createInboundPipeline([...])`. Includes the `NormalizedMessage → InboundMessage` mapping and the `WhatsAppOutboundSender` (markdown→WhatsApp). **Rename + swap in your own agent.** |
| `wa-session-store.ts` | `SqlSessionStore` — DO-SQLite `SessionStore` (durable cart + checkout effect log). **Reusable verbatim.** |
| `webhook-routes.snippet.ts` | The Worker fetch-handler routes (GET verify / POST inbound tenant-scoped fan-out / `/wa-pay` resume). |
| `wrangler.snippet.jsonc` | The `PharmacyWa` DO binding + SQLite migration + the secrets list. |

> There is **no `wa-turn.ts`** anymore — the hand-rolled "download image → run → send" logic was replaced by the shared pipeline. If you see that file in an older copy, delete it.

## Adapt it to your agent

1. In `wa-agent.ts`, replace `buildPharmacyAgent(...)` with your own `defineAgent`/builder; keep the `createRuntime(... sessionStore: new SqlSessionStore(this.ctx.storage.sql))` + `createDurableObjectInboundRuntime({...})` wiring.
2. Keep the pipeline middleware list as-is unless you have a reason to change order (it encodes correctness: claim before run, consent before run, window-record before guard).
3. If your agent has a durable suspend step resumed by an external link (checkout), keep the `/wa-resume` route + `signalEvent`. If not, drop them.
4. Rename the DO class consistently across `wa-agent.ts`, the entry `export { … }`, and `wrangler.jsonc`.
5. Tenant-scope your keys: the DO name and the `ConversationKey` use `platform + phoneNumberId + from`.

`wa-agent.ts`'s outbound sender is the only WhatsApp-specific bit (markdown→`*bold*`); everything else is channel-agnostic pipeline. Unit-test the DO with the in-memory ledger/stores + a fake `OutboundSender` (see `apps/playground/pharmacy-rx-agent/src/wa.test.ts` for the adversarial suite: dup retry → one turn, two `/wa-pay` → one confirm, burst merge, eviction replay, tenant isolation).

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

Run wrangler from the worker directory.

## Gotchas specific to CF

- **`ctx.waitUntil` for the turn, 200 immediately.** Running the model inside the webhook request risks Meta's retry timeout → duplicate deliveries. The DO's `InboundLedger.claim` also dedupes retries, but acking fast is still correct.
- **`new_sqlite_classes` (not `new_classes`).** The DO needs SQLite for the session store + ledger. Bump the migration `tag` if you already have migrations.
- **The DO class must be exported from the Worker's entry module**, or wrangler can't bind it.
- **Depend on `agents/chat`** — `TurnQueue`/`messageConcurrency` come from Cloudflare's `agents` package (already a dep of `@kuralle-agents/cf-agent`).
- **Static assets** (web chat UI, privacy page, icon) live in `public/` alongside this — CF serves them; the Worker handles the dynamic routes. The **web chat ingress (`routeAgentRequest`/`AIChatAgent`) is a separate channel** and is not routed through this pipeline.
