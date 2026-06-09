# Pharmacy Rx Ordering Agent — Work Breakdown Structure (SOP / Kanban)

A WhatsApp-style pharmacy ordering agent (built for the bot/web, modeled as a WhatsApp
conversation) that:

1. accepts a **chat message + prescription image**,
2. **extracts** the prescribed items (vision) and **cross-checks inventory**,
3. answers follow-up questions and maintains a **persistent cart**,
4. on purchase intent, sends a **payment link** and **suspends** (human-in-the-loop),
5. when the link is **hit**, **resumes** the conversation and confirms "order completed",
6. runs on **Cloudflare Durable Objects** — one DO per thread = multi-tenant isolation +
   durable history/cart that survive the client closing the chat.

This demo exercises the two platform features end-to-end: **multimodal intake** (the image)
and **durable HITL approval / resume** (the payment link → resume).

## Architecture (one DO per thread)

```
client (web chat, WhatsApp-style)
  │  message + image  ──────────────►  Worker  ──►  PharmacyAgent DO (sessionId = thread)
  │                                                   ├─ BridgeSessionStore (CF messages + state)
  │                                                   ├─ OrchestrationStore (flow state, cart)
  │                                                   └─ Kuralle Runtime (flow agent)
  │  ◄──────────  "in stock; place order?"  ──────────┘
  │  "yes, buy"  ──────────────────────────────────►  confirm_order → mint token → SUSPEND
  │  ◄──────────  payment link /pay/<token>  ─────────┘
  │
  └─ GET /pay/<token>  ──►  Worker  ──►  DO.signalDelivery(payment) ──► RESUME ──► "order completed ✅"
                                                                          (broadcast to live client)
```

- **Multi-tenant:** DO id derived from thread id; different threads → isolated DOs/state.
- **Persistence:** cart + flow state + history live in DO SQLite; closing/reopening the chat
  replays full history for that thread.
- **HITL:** `confirm_order` suspends on a `payment` signal; `/pay/<token>` delivers it.

## Kanban (status: TODO / DOING / DONE — mirrored in the Task tracker)

### P0 — Framework gaps (in `@kuralle-agents/cf-agent`; breaking OK)
- **T1** Multimodal through cf-agent — `getLastUserInput()` → `UserInputContent` (map file parts). *(gap)*
- **T2** HTTP-resume path — `KuralleAgent.onRequest` route delivers `signalDelivery`, resumes the run,
  persists + broadcasts the resumed assistant turn through CF's reply machinery. *(gap, highest risk)*

### P1 — Domain
- **T3** Inventory dataset (JSON: ~20 meds, stock, price) + `check_inventory` durable tool.
- **T4** Prescription extraction — vision collect/submit node → normalized item list.
- **T5** Persistent cart — session state + `add_to_cart` / `remove_from_cart` / `view_cart` tools.

### P2 — Conversation (SOP in flow, not prompt)
- **T6** Pharmacy flow: `intake → present → cart` with off-flow Q&A (hybrid answering).
- **T7** Checkout: mint token + payment link + `confirm_order` suspend-for-payment (HITL).
- **T8** Resume: `/pay` signal → `complete_order` → "order completed" reply.

### P3 — Cloudflare app
- **T9** Worker entry + `wrangler.jsonc` (DO binding, smallest config) + Env (model + transcription keys).
- **T10** `/pay/:token` route → token store → DO signal delivery.
- **T11** Minimal multimodal web chat client (send text+image; render history) OR scripted test client.

### P4 — Deploy & live test on Cloudflare (BLOCKED on write-scoped CF creds)
- **T12** `wrangler deploy` to CF. *(BLOCKED: token is read-only)*
- **T13** Multi-tenant: two threads, isolated carts/history.
- **T14** Multimodal: real prescription image extracted + matched to inventory.
- **T15** Persistence: close/reopen a thread → full history + cart intact.
- **T16** HITL/resume: hit payment link (incl. after closing chat) → "order completed" appears.

### P5 — Wrap
- **T17** README + final WBS state; decide starter-project promotion.

## STATUS (2026-06-10) — ✅ WORKING END-TO-END, PUBLISHED 0.8.0

Deployed live: `https://pharmacy-rx-agent.mithushancj.workers.dev`. All behaviors verified on Cloudflare:

- **Multimodal intake** ✓ — the model reads a prescription image (vision) and extracts details.
- **Inventory + persistent cart** ✓ — `check_inventory` returns live stock/price; `add/remove/view_cart` mutate a DO-persisted cart.
- **Durable HITL checkout** ✓ — on payment confirmation the model `enter_flow`s the checkout flow, which emits a payment link and **suspends** on the `payment` signal; hitting `GET /pay/<token>` **resumes** the run → "order completed", cart cleared, `lastOrder` recorded.
- **Persistence** ✓ — run state (cart, order) + history persist in the DO across reconnects.
- **Multi-tenant** ✓ — one DO per thread id; isolated state.

**Dep fix (was blocking):** bumped cf-agent to `@cloudflare/ai-chat@^0.8.4` + `agents@^0.15` (the `0.1.9`/`0.11.5` skew crashed `AIChatAgent.onMessage` with `this.mcp.ensureJsonSchema`). Also fixed two real framework bugs surfaced live: (1) `BridgeSessionStore` now persists/restores the durable run journal (`durableRuns`) — was "Run not found"; (2) core `RunContext.resetCallsites()` at flow entry — a run entered via `enter_flow` after an answering turn was re-suspending on a callsite mismatch.

**Published:** all 30 `@kuralle-agents/*` packages at **0.8.0** on npm.

## Risks / open items
- **Deploy creds (BLOCKER):** wrangler token is read-only (`account:read, user:read`); deploy needs
  Workers Scripts:Edit + Durable Objects write. Needs `wrangler login` (deploy scopes) or an API token.
- **"Coral" deploy tooling:** assuming CF Worker + DO via `@kuralle-agents/cf-agent`, deployed with
  wrangler (vs Alchemy, which kuralle-platform uses). To confirm.
- **T2 resume broadcast:** delivering a resumed assistant turn into CF's persist+broadcast path
  (so a live client sees "order completed") is the trickiest integration — prototype early.
- **Vision model:** extraction needs a vision-capable model (gpt-4o / gemini-2.x); set provider key in Env.
- **Test prescription image:** source a clear sample Rx image (search) for T14.
```
