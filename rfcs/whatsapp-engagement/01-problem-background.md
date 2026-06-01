---
rfc: whatsapp-engagement
part: 01-problem-background
---

# RFC: WhatsApp AI customer-engagement agents on Kuralle flow primitives

## 1. Problem Statement

A developer building a WhatsApp customer-engagement agent on Kuralle gets the hardest parts for free — a durable, resumable conversation state machine and a production WhatsApp transport — but cannot ship safely. Three correctness defects and one capability gap block production use:

1. **Closed-window free-form sends leak.** WhatsApp rejects free-form messages outside the 24-hour customer-service window, yet the runtime→platform bridge sends them unconditionally (`packages/kuralle-messaging/src/adapter/stream-mapper.ts:111`). The `WindowTracker` records the window but nothing enforces it.
2. **Outbound is text-only; inbound selection is lossy.** The default mapper sends only buffered text and never renders `collect`/`decide` options as WhatsApp buttons/list/Flows. Inbound button/list taps reach the flow as the display label, not the stable id (`createMessagingRouter.ts:66` derives `input = message.text ?? '[type]'`); WhatsApp Flow `nfm_reply` submissions are not parsed at all (`messaging-meta/src/whatsapp/client.ts:592,701`). Routing becomes language- and label-dependent guesswork.
3. **No human-handoff ownership gate.** Nothing suppresses the bot while a human owns a conversation.
4. **No proactive outbound.** No consent enforcement, broadcasts, drip sequences, or compliant re-engagement after the window closes.

**Success = these invariants hold post-implementation:**
- A free-form send is never emitted to the platform when the window is closed (it converts to an approved template or defers with an observable outcome).
- A customer's button/list/Flow selection routes the flow deterministically by stable id, independent of label text or language; `nfm_reply` form data lands in flow state.
- While a conversation is human-owned, the bot emits zero outbound; releasing ownership resumes the paused flow.
- No outbound is sent to a customer who has not opted in or who has opted out (`STOP`).
- A broadcast that receives a reply hands the customer into a flow; a drip stops on reply; idempotent under retry.
- All of the above run on one Kuralle runtime alongside Messenger/web, with Kuralle's existing durable, exactly-once, resumable guarantees intact.

## 2. Background

See [`PRD.md`](../../PRD.md) for the product framing and the full 40 user stories, and [`RESEARCH.md`](../../RESEARCH.md) for WhatsApp Cloud API constraints (sourced from Meta docs), WATI/BSP prior art, and the `file:line` codebase grounding. Summary of the current state this RFC builds on:

**Reused, not rebuilt (verified):**
- **Flow engine** — `reply`/`collect`/`action`/`decide`, the `Transition` union, durable run/replay with an exactly-once effect log, `SessionStore`, and `hostLoop` precedence (resume active flow → triage → free conversation). `packages/kuralle-core/src/{types/flow.ts,flow/runFlow.ts,runtime/ctx.ts,runtime/hostLoop.ts}`.
- **WhatsApp transport** — `WhatsAppClient` (`sendText`/`sendMedia`/`sendInteractive`/`sendTemplate`/`sendTextOrTemplate` + templates/flows CRUD; webhook verify/normalize/dedup). `packages/kuralle-messaging-meta/src/whatsapp/`.
- **Runtime bridge** — `createMessagingRouter({ runtime, platforms, sessionResolver?, responseMapper? })`, `StreamMapper`, `WindowTracker` (`isWindowOpen`/`getExpiry`/`recordInbound`/`recordExpiry`), the existing `SessionResolverChain`/`SessionResolverPlugin` idiom. `packages/kuralle-messaging/src/`.

**The 5 verified gaps (drive Sections 3–8):**
1. Window tracked, not enforced (`stream-mapper.ts:111`).
2. `ResponseContext` (`types/adapter.ts:21`) and `PlatformClient` (`types/client.ts:43`) have no `sendTemplate` and no window state; `sendTemplate`/`sendTextOrTemplate` live only on the concrete `WhatsAppClient`.
3. Input is text-only; the stable `interactive.id` is dropped and `nfm_reply` unparsed.
4. The default mapper renders no interactive output.
5. No ownership/consent/proactive concepts exist.

### Footnotes — interface designs considered (Section 4 chose the Hybrid)

The Section-4 interface was selected via three parallel `design-an-interface` candidates. Recorded here so reviewers do not re-litigate:

- **[fn-A] "The Bridge Knows" (minimal, correct-by-default).** Fewest public concepts; additive; `sendText` becomes the window-safe path; `choice()`/`smartSend()` author verbs; one `whatsappEngagement({...})` wiring. **Adopted** as the author-facing surface. Lost as a *whole* because it under-separates the multiple cross-cutting gates (consent/ownership/window) into one module.
- **[fn-B] "Capability-Typed Contracts" (compile-time safety).** Discriminated unions make illegal states unrepresentable; `sendText`→`sendWindowed`; new first-class `InteractiveNode` in the core `FlowNode` union. **Rejected as the spine** — breaking core changes ripple through every exhaustive switch in `runFlow`/stream/studio and force a coordinated whole-monorepo release (the repo's "version + publish together" gotcha). **Adopted partially:** its discriminated `SendOutcome`/`WindowState`/`SendDecision` value types.
- **[fn-C] "Send Pipeline" (composable middleware).** Ordered `OutboundMiddleware` chain + symmetric inbound resolver chain mirroring the repo's `SessionResolverChain`. **Adopted** as the *internal* structure (each gate is one link). Lost as the *public* API because exposing the pipeline as the primary surface leaks an `OutboundRequest`/`Payload` envelope and makes middleware ordering a footgun for authors.

**Hybrid stance:** A's surface, C's internals, B's value types, no breaking core-flow changes.
