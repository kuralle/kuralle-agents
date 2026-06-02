# 02 — Capability inventory (what the Kuralle engine already provides)

Firsthand from this repo (the engagement framework shipped Sprints 0–7 + the example apps). Legend: **HAVE** = shipped + tested; **PARTIAL** = engine primitive exists, product surface missing; **NET-NEW** = not started.

| Product capability | Status | Where (repo) | Notes |
|---|---|---|---|
| **Durable, resumable run state (FSM)** | HAVE | `core/src/runtime/{Runtime.ts, openRun.ts, durable/}` | `RunState` persisted; pause/resume via signals; `runId == sessionId` (`openRun.ts:31`). Conversations survive restarts. |
| **Exactly-once tool execution / replay** | HAVE | `core/src/runtime/ctx.ts` (`replayOrExecute`, `toolEffectKey`) | Effect log dedupes on replay; tool side effects run once. Approval pause (`__approval`) is durable. |
| **Structured flows (SOP not prompt)** | HAVE | `core/src/flow/runFlow.ts`, `types/flow.ts` | `reply`/`collect`/`decide`/`action` + `Transition`; oscillation guard. Free-form extraction via `collect`+zod. |
| **Window-safe outbound pipeline (leak-proof)** | HAVE | `messaging/src/adapter/{outbound-pipeline.ts, middleware/window-guard.ts}` | Non-removable **terminal** `windowGuard`; constructor refuses a chain without it. Closed-window free-form can't leak. |
| **Pluggable window store (fail-closed)** | HAVE (in-mem) / PARTIAL (durable) | `messaging/src/adapter/window-store.ts` | In-memory default fail-closed; **durable Redis/PG adapter = backlog BK-06** (needed for multi-process). |
| **Channel-agnostic ChannelPolicy** | HAVE | `engagement/src/policy.ts`, `policies/{whatsapp,web,instagram}.ts` | One bot across WhatsApp/web/IG; add a channel = one policy. Proven by `same_bot_across_channels`. |
| **Smart-send strategist (AI template selection + guardrails + audit)** | HAVE | `engagement/src/{strategist.ts, closed-window-recovery.ts, catalog.ts, selector.ts}` | Closed-window text→APPROVED template behind deterministic guardrails; defers on no-fit; audit per conversion. |
| **Interactive fidelity (render per channel, route by stable id)** | HAVE | `engagement/src/{interactive-renderer.ts, render-instagram-interactive.ts}`, `authoring.ts` (`withChoices`) | Buttons/list/cta/Flows (WA), quick-reply/carousel (IG); inbound id-routing label-independent. |
| **Human handoff (ownership) — the GATE** | HAVE | `engagement/src/ownership.ts`, `createMessagingRouter` inbound gate | Inbound gate skips `runtime.run` while human-owned; `escalate→human` claims; release resumes. **The inbox UI is NOT built (BK-02).** |
| **Consent / opt-out (STOP)** | HAVE | `engagement/src/consent.ts` | Customer-keyed; default opted-out; `consentGate` blocks; STOP. |
| **Proactive: broadcasts (idempotent) + drips (stop-on-reply) + scheduler** | HAVE (engine) | `engagement/src/{broadcast.ts, broadcast-ledger.ts, drip.ts, scheduler.ts}` | `BroadcastLedger` idempotency; in-process scheduler + documented prod adapters (BullMQ/Cloud Tasks). **Campaign composer UI = NET-NEW.** |
| **WhatsApp / Instagram / Messenger clients** | HAVE | `messaging-meta/src/{whatsapp,instagram,messenger}/client.ts` | WA: text/media/interactive/template, `templates.list`, `nfm_reply` parse. IG: `sendTextWithTag` (HUMAN_AGENT), quick-replies, carousels. |
| **Session stores (durable backends)** | HAVE | `kuralle-{redis,postgres,upstash,lancedb,vectorize}-store` | Redis/Postgres/Upstash session backends already exist (ownership/consent/window can ride these). |
| **HTTP + serverless runtimes** | HAVE | `kuralle-hono-server`, `kuralle-cf-agent` | Node/Bun via Hono; Cloudflare Workers/Durable Objects. |
| **RAG / grounding (CAG)** | HAVE | `kuralle-rag`, `kuralle-rag-loaders` | Retrieval + grounding providers wired into the runtime. |
| **Voice channel (realtime + cascaded)** | HAVE | `kuralle-realtime-audio`, `kuralle-livekit-plugin*` | A *voice* `ChannelPolicy` is a natural future channel. |
| **Template catalog over Meta API (quality/paused)** | HAVE | `engagement/src/catalog.ts`, `messaging-meta/.../templates.ts` | Filters APPROVED + non-paused; component-aware `OutboundTemplate`. **Template authoring + Meta-submission UI = NET-NEW.** |
| **Visual flow builder UI** | NET-NEW | — | No-code canvas → our flow graph. (Backlog BK-04 = "no-code visual flow builder", v2.) |
| **Team inbox UI (live agent surface)** | NET-NEW | — | Ownership *gate* shipped; inbox *surface* explicitly out of scope (BK-02). |
| **Contacts / CRM / segments** | NET-NEW | — | Backlog BK-01. Consent/campaign state is keyed by customerId but there's no contact store/UI. |
| **Analytics / reporting dashboards** | NET-NEW | — | Backlog BK-03. Stream taxonomy (`HarnessStreamPart`) + audit entries are the raw signal; no aggregation/UI. |
| **Onboarding (Meta Embedded Signup / connect a number)** | NET-NEW | — | No tech-provider/Embedded-Signup flow; today you bring a WhatsApp Cloud API number + token. |
| **Multi-tenant / auth / billing / usage metering** | NET-NEW | — | Framework is single-tenant library; no SaaS control plane. |
| **Preview / simulator / test-runner UI** | PARTIAL | offline fake-client tests + example `run.ts` | The deterministic fake-client harness is a *headless* simulator; no UI. |
| **Observability hooks** | PARTIAL | `Hooks` (`onStreamPart`, `onStart/onEnd`), audit log, Langfuse demo | Hooks + traces exist; no product dashboard. |

## Read of the inventory
**The hard, differentiated engine layer is largely DONE** (durability, window-safety, channel-agnosticism, strategist, interactive, consent, broadcasts). **What's missing is almost entirely the SaaS/product shell** — the visual UI surfaces (builder, inbox, campaign composer, analytics), the onboarding (Meta Embedded Signup), and the multi-tenant control plane (auth/billing/metering). That is the inverse of most competitors, who have a rich UI shell over a shallow/bolt-on agent engine. The build scope (`03`) and moat (`04`) follow from this asymmetry.
