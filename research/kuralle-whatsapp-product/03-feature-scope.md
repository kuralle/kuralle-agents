# 03 — Feature scope / work breakdown for the FINAL product

Scope to ship "Build your next WhatsApp Bot with Kuralle" as a complete commercial product (not MVP). Effort tiers are rough team-quarters of effort for a small senior team: **S** ≤2–3 wks · **M** ~1–1.5 mo · **L** ~2–3 mo · **XL** ~3–6 mo. "Engine reuse" = how much the shipped framework already carries.

## A. Developer / code-first surface (our strength — lead with it)
| Area | Status | Effort | Notes |
|---|---|---|---|
| TypeScript SDK (`defineAgent`/flows/`engagement()`) | HAVE | — | Already shipped + 3 example apps + authoring docs. |
| Templates/starters (`create-kuralle-agents`) | HAVE/PARTIAL | S | Scaffolder exists; add WhatsApp-bot starter presets. |
| Docs site + recipes | PARTIAL | M | Astro docs exist; needs full guides, API ref, cookbook. |
| Local dev: CLI run + headless simulator | PARTIAL | S–M | Fake-client harness exists (headless); wrap as a `kuralle dev` CLI + transcript replay. |

## B. Channel onboarding & connectivity (gating for self-serve)
| Area | Status | Effort | Notes |
|---|---|---|---|
| Meta **Embedded Signup** (become a Tech Provider; connect a WABA in-app) | NET-NEW | L | The single biggest gate to self-serve WhatsApp; OAuth + WABA/number provisioning + webhook registration. Compliance + Meta review. |
| Number/channel manager (WA + IG + web widget keys) | NET-NEW | M | Web widget (SSE) is straightforward given `webPolicy`; IG/WA via Embedded Signup. |
| Webhook ingest at scale (multi-tenant routing) | PARTIAL | M | `createMessagingRouter` + hono-server exist; needs tenant routing + signature mgmt + retries/queue. |

## C. Visual builder (table-stakes for non-devs)
| Area | Status | Effort | Notes |
|---|---|---|---|
| No-code flow canvas → compiles to our flow graph | NET-NEW | **XL** | The largest UI item. Node palette (reply/collect/decide/action/withChoices/smartSend) ↔ a serializable flow IR ↔ the runtime. Two-way (code⇄canvas) is the hard, high-value version. |
| Flow IR / serialization (canvas ↔ `defineFlow`) | NET-NEW | L | Prereq for the canvas; today flows are code. Need a JSON IR the runtime can execute + the canvas can edit. |
| In-canvas test/preview (drive the simulator) | NET-NEW | M | Reuse the headless fake-client; render a chat preview + per-channel render preview. |

## D. WhatsApp template lifecycle (real WhatsApp depth)
| Area | Status | Effort | Notes |
|---|---|---|---|
| Template **authoring + Meta submission/approval** workflow UI | NET-NEW | L | Compose template → submit to Meta → track PENDING/APPROVED/REJECTED → sync quality/paused. Engine already *consumes* the catalog (`catalog.ts`); UI + submission API net-new. |
| Strategist config UI (map intents→templates, params, guardrails) | NET-NEW | M | Surface the smart-send strategist (a real differentiator) as a configurable mapping + audit viewer. |

## E. Live team inbox + human handoff (table-stakes for support)
| Area | Status | Effort | Notes |
|---|---|---|---|
| Agent inbox UI (conversation list, assignment, reply, notes) | NET-NEW | **XL** | Ownership *gate* is shipped (bot suppresses while human-owned, resumes on release); the *surface* (realtime inbox, presence, routing, canned replies, SLA) is large. |
| Realtime transport for the inbox (WS/SSE fan-out) | PARTIAL | M | Stream taxonomy + cf-agent/DO + ws-bench exist; needs an agent-facing realtime layer. |

## F. Campaigns (proactive)
| Area | Status | Effort | Notes |
|---|---|---|---|
| Broadcast/drip **composer UI** (audience → template → schedule) | PARTIAL | M–L | Engine: idempotent broadcasts + drips + scheduler **HAVE**; the composer UI, audience builder, send-time analytics net-new. |
| Send infra at scale (rate limits, Meta tiers, retries) | PARTIAL | M | Ledger + scheduler exist; needs durable queue + Meta messaging-tier/rate handling. |

## G. Contacts / CRM / segments
| Area | Status | Effort | Notes |
|---|---|---|---|
| Contact store + attributes + segments + import | NET-NEW | L | Consent/campaign state is customerId-keyed but there is no contact DB/UI (BK-01). |

## H. Analytics / observability
| Area | Status | Effort | Notes |
|---|---|---|---|
| Conversation analytics, funnels, deflection, CSAT | NET-NEW | L | Raw signal exists (`HarnessStreamPart`, audit entries, conversation outcomes); aggregation + dashboards net-new (BK-03). |
| Agent/flow eval + regression harness (product surface) | PARTIAL | M | `kuralle-eval` + golden tests exist; product-ize as a UI. |

## I. Control plane (SaaS shell)
| Area | Status | Effort | Notes |
|---|---|---|---|
| Multi-tenant, auth/RBAC, projects/orgs | NET-NEW | L | Framework is a single-tenant library today. |
| Billing + usage metering (per-conversation, Meta fee passthrough) | NET-NEW | L | Must meter Meta conversation categories; standard but non-trivial. |
| Durable WindowStore/BroadcastLedger/Ownership (multi-process) | PARTIAL | S–M | Interfaces exist (Redis/PG backends exist); wire durable adapters (BK-06) — required before multi-tenant scale. |

## Scope read
- **Net-new is ~80% UI/SaaS-shell** (builder XL, inbox XL, Embedded Signup L, template-approval L, CRM L, analytics L, control plane L). The hard *engine* correctness work is done.
- **Two XL anchors**: the visual builder and the team inbox. Each is a product in itself. A "complete product" realistically needs both, but they can be **sequenced** — and a code-first + strong-API positioning lets us ship value before either is complete.
- **Fast wins that show our edge**: strategist config + audit UI (M), per-channel render preview (M), durable adapters (S–M), broadcast composer over the existing engine (M).
- **Hard external dependency**: Meta Embedded Signup / Tech Provider review — long-lead, gates self-serve onboarding; start early.
