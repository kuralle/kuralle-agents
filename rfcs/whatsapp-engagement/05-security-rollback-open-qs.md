---
rfc: whatsapp-engagement
part: 05-security-rollback-open-qs
---

## 10. Security Considerations

- **Webhook authenticity (unchanged, reused).** Inbound is verified via the existing `verifySignature` (Meta app-secret HMAC). No new ingress is added; the engagement layer runs strictly downstream of verification.
- **Compliance is a security boundary, not a nicety.** Two new invariants prevent account-level harm: (1) no closed-window free-form send (REQ-1) — avoids policy violations / delivery failures; (2) no send without opt-in and immediate `STOP` honoring (REQ-11). Both are enforced as default middleware that fail closed (`deferred`/`suppressed`), never open.
- **AI template selection is bounded.** The `TemplateSelector` can only choose from the pre-filtered APPROVED/non-paused set and cannot send free-form or invent templates; its output params are re-validated before send (REQ-5). A selector timeout/error fails to `defer`, never to an unguarded send. Prompt-injection in user text cannot widen what is sendable (the catalog filter is deterministic and outside the AI).
- **Audit trail.** Every template conversion is recorded (`AuditSink`) with requested text, chosen template, and params — supporting incident review of any unexpected re-engagement.
- **Secrets.** WhatsApp access token / app secret remain in env (as today); the new package introduces no new secret storage. Consent/ownership state is non-secret per-conversation metadata in the `SessionStore`.
- **PII.** Customer phone numbers and message content already transit the session; this RFC adds no new external sink for them (the audit log is local/injected).

## 11. Rollback and Abort Criteria

**Abort the build if:**
- The additive `HarnessStreamPart` variant forces a non-additive change to `runFlow`'s exhaustive switches (i.e. it cannot stay additive) — stop and revisit Q3 (would mean the chosen design's no-breaking-core premise is wrong).
- Window enforcement cannot be made default without breaking the Messenger/web paths in the multi-platform example (the gate must be channel-agnostic and a no-op for non-template channels).
- `typecheck:all` or the existing `kuralle-messaging`/`-meta` suites go red and cannot be made green without a workaround.

**Rollback procedure:**
- The new package is independently revertable (delete `@kuralle-agents/whatsapp-engagement`; it is not a dependency of anything else).
- The `messaging` core changes are behind the pipeline: shipping the default chain as `[windowGuard]` only (no engagement middleware) degrades to "window-safe, text-only" — strictly safer than today and a valid intermediate landing point. If the pipeline itself regresses, revert `createMessagingRouter`/`StreamMapper` to the prior `defaultMapResponse` (text-only) — restores exact current behavior.
- Follow the monorepo "version + publish together" rule: `core` (stream variant) + `messaging` + `messaging-meta` + `whatsapp-engagement` version and publish in one release so consumers never install a split graph.

## 12. Open Questions

All resolved (carried from [`RESEARCH.md`](../../RESEARCH.md) §4); each has a committed `**Proposal:**`.

- **Q1 — Where does window enforcement live?** Extend the response/platform contract vs inject the tracker vs middleware.
  **Proposal (resolved):** A non-removable `windowGuard` `OutboundMiddleware` in `@kuralle-agents/messaging`, default-installed by `createMessagingRouter`; template send via a capability-detected `OutboundSink.sendTemplate?` (no WhatsApp type leaks into the generic bridge). Correct-by-default; channel-agnostic.

- **Q2 — Input-resolution seam for stable-id routing.** New hook vs extend `SessionResolver`.
  **Proposal (resolved):** A dedicated `InboundResolverChain` mirroring the existing `SessionResolverChain` (`InteractiveResolver` then `TextResolver`); `MessagingRouterConfig.inputResolver?`. Keeps session resolution and input derivation as separate concerns.

- **Q3 — How a node declares interactive options.** New stream-part variant vs metadata vs new node kind.
  **Proposal (resolved — your selection):** Additive optional `choices` metadata on `collect`/`decide` + ONE additive `{type:'interactive'}` `HarnessStreamPart` consumed by the renderer middleware. No new `FlowNode` kind; additive to core only.

- **Q4 — Smart-send node vs guard; AI seam location.**
  **Proposal (resolved):** Both — a default automatic `strategistMiddleware` guard AND an explicit `smartSend` `action` node, sharing one `SmartSendStrategist` instance. The AI runs in an injected `TemplateSelector` inside the strategist, behind deterministic guardrails (filter/validate/audit).

- **Q5 — Persistence of ownership/consent/window/campaign.** SessionStore vs external vs hybrid.
  **Proposal (resolved — your selection):** `SessionStore`-backed `OwnershipStore`/`ConsentStore`/campaign membership, keyed by the existing `sessionId` (`{platform}:{threadId}`); the messaging window stays in the in-memory `WindowTracker` (corrected by status webhooks). No new infrastructure; multi-process safe via the chosen `SessionStore` backend.

- **Q6 — Scheduler boundary for broadcasts/drips.** External-only vs in-package vs pluggable.
  **Proposal (resolved — your selection):** A pluggable `Scheduler` interface in the package with a simple default in-process implementation (sufficient for the example) and documented production adapters (BullMQ / Cloud Tasks / cron). Stop-on-reply via session state; broadcast idempotency via an explicit `BroadcastLedger` (R-07), independent of the scheduler impl.

## Revision notes (adversarial review)

Codex ran a read-only review against the current tree (`bun test` for messaging = 413 pass; `typecheck:all` green) and found 8 blockers + 3 should-fixes. All folded in. Each row: finding → grounding `file:line` → where amended.

| ID | Finding | Grounding | Amendment |
|---|---|---|---|
| R-01 | Window guard covered only `text`; media/interactive are also free-form and rejected outside the window | `03:windowGuard` (old), `whatsapp/client.ts:167,198` | REQ-16; §6.1 guards every non-template payload |
| R-02 | Pipeline bypasses: router `fallbackMessage` + custom `responseMapper` call the client directly | `createMessagingRouter.ts:81`, `stream-mapper.ts:82-89` | REQ-17; §6.1 invariant; chunk A3 reshapes the `responseMapper` contract |
| R-03 | No `selection`/`formData` propagation seam; `RunOptions` is `input?: string` only | `Runtime.ts:51`, `openRun.ts:77-92` | REQ-20; §4.8 `RunOptions.selection`; chunk A0.2; §6.3 |
| R-04 | `InboundMessage` lacks `button`/`formResponse`; `nfm_reply` unparsed; resolver referenced nonexistent fields | `messages.ts:191`, `whatsapp/client.ts:609-620,701-706` | §4.10; chunk A0.1 |
| R-05 | Session double-prefix `whatsapp:whatsapp:…`; consent keyed by thread not customer | `session-resolver.ts:14`, `whatsapp/client.ts:592` | REQ-19; §4.11 customer-identity model; §5.3; chunk A0.1 |
| R-06 | In-memory `WindowTracker` breaks multi-process window enforcement | `window-tracker.ts:25`, `createMessagingRouter.ts:44` | REQ-18; §4.9 `WindowStore` (fail-closed); chunk A0.3 |
| R-07 | Broadcast idempotency can't use the per-run effect log (`runId == sessionId`); no `seed` on `RunOptions` | `idempotency.ts:17`, `openRun.ts:31`, `Runtime.ts:51` | §6.5 `BroadcastLedger` keyed by `(campaign,customer)`; chunk E2 |
| R-08 | `escalate→'human'` hits the agent-switch path (throws on missing agent); outbound-only gate still runs the flow on inbound | `runFlow.ts:161`, `Runtime.ts:172-181`, `createMessagingRouter.ts:55-79` | REQ-21; §4.11 inbound ownership gate; §6.5 `onInbound`; chunk D1 |
| R-09 | Constructor checks `window-guard` presence, not that it is terminal | `03:OutboundPipeline` (old) | chunk A3 enforces ordering/terminal guard |
| R-10 | `OutboundTemplate.params: Record<string,string>` too weak vs WhatsApp components; catalog lacks quality/paused | `whatsapp/types.ts:110-140,367-380` | §4.2 component-aware `OutboundTemplate`; chunk B2 extends `TemplateInfo` |
| R-11 | Button/list limits silently sliced in the client | `whatsapp/client.ts:340` | chunk C2 validates in renderer (explicit error) |

### rev3 — omnichannel re-scope

Per the channel-scope decision, the engine is channel-agnostic and channel differences are isolated behind an injected `ChannelPolicy` + `ClosedWindowStrategy` (§4.12, REQ-22). Package renamed `@kuralle-agents/engagement`. The smart-send strategist becomes the WhatsApp policy's `ClosedWindowStrategy`, not the engine. Three adapters this cut: WhatsApp (`template`), Web (`none`/always-open), Instagram (`message-tag`/`HUMAN_AGENT`, limited proactive). Messenger deferred. New chunks A0.4 (ChannelPolicy + web null policy), G1 (WhatsApp policy), G2 (Instagram policy); F1/F2 generalized to `engagement({ policies })`. **Q7 — Instagram window + tag + interactive specifics — RESOLVED (verified 2026-06, Sprint 6 / S6-02).** Re-verified against current Meta Instagram Platform docs: 24h standard window ✅; `HUMAN_AGENT` message tag extends the response window to **7 days** ✅; quick replies **max 13** (titles ≤20 chars) ✅; generic-template carousel **max 10 elements**, button template **≤3 buttons** ✅; no template-approval system (limited proactive) ✅; tag wraps **text only** → interactive/media outside the window **defer** (IG-CW) ✅. **No divergence from the RFC assumptions — the `instagramPolicy` design in §4.12 stands; G2 proceeds.** Enrichments captured for G2: tag duration = 7 days; enforce the 20-char quick-reply title cap in the IG renderer (no silent truncation, per R-11). Verification note: `sprints/sprint-6/artifacts/s6-02-instagram-verification.md`.

### rev4 — Cursor verification fold-in

Cursor (`--model auto`) verified rev3 against the tree (ran `bun test` for messaging + messaging-meta → 413 pass), confirmed the RFC's file:line citations are accurate, and distinguished spec-resolved (R-01/04/05/06/10/11) from code-not-yet-implemented. Two blockers + should-fixes folded:

| ID | Finding (Cursor) | Grounding | Amendment |
|---|---|---|---|
| R-08-B | `escalate→'human'` had no interception seam — would hit the agent-switch throw | `runFlow.ts:161-163`, `Runtime.ts:178-180` | **REQ-23** terminal handoff targets (pause+emit) + `humanHandoff()` node; §4.11 |
| IG-CW | IG `message-tag` over-generalized — client only tags TEXT; interactive/media untaggable | `instagram/client.ts:423-438`,`186-195`,`299-316`,`323-344` | §4.12 IG policy: tag text only, else defer; §6.1 `message-tag` branch text-only; corrected IG interactive mapping to real methods |
| R-02-S | `WhatsAppClient.sendTextOrTemplate` is another direct-send bypass | `client.ts:287-294` | REQ-17 amended — deprecate/wrap behind `OutboundSink` |
| R-07-S | `BroadcastLedger` lacked an interface / atomicity | §6.5 prose only | §4.7 adds `interface BroadcastLedger { putIfAbsent(key): Promise<boolean> }` (atomic CAS); REQ-12 reworded |
| R-03-S | selection merge vs durable replay unspecified | `openRun.ts:77-92`, `durable/types.ts:32` | §4.8 — persist merged `selection` into `run.state` before the first effect |
| R-09-S | terminal-guard assertion in A3 but not the §7 blueprint | `04:19`, `03:207-208` | §7 blueprint asserts last middleware == `window-guard` |
| MW-ORD | outbound middleware order ambiguous | `02` §4.1 | committed order: `[consent, ownership, interactiveRenderer, windowGuard(+strategist), sink]` |
| REQ-STALE | §4.1 error-case wording text-only | §4.1 | "non-template payload while `window.open===false`" |
| PKG-NAME | `whatsapp-engagement` vs `engagement` drift | §4 conventions | fixed → `@kuralle-agents/engagement`, dir `packages/kuralle-engagement` |
| Q7-IG | IG mapping assumed "quick replies" but buttons route to button-template | `client.ts:186-195` vs `299-316` | §4.12 corrected to the real IG methods; Q7 deferral confirmed appropriate |

Remaining `BroadcastLedger` interface (§4.7), middleware-order commit (§4.1), and §7 terminal-guard assertion are tracked in `.handoff/wbs-rfc-rev3-cursor.md` and folded into the affected chunks (A0.5 terminal-handoff, A3 ordering, E2 ledger, G2 IG-text-tag). Cursor's verdict moves to **ready** once R-08-B + IG-CW are amended (done here).

Note (Consider): two `HarnessStreamPart` unions exist (`core/src/types/stream.ts` and `types/voice.ts`, both barreled at `types/index.ts:8-9`). The additive `interactive` variant is added to the **text/stream** union (`types/stream.ts`) — the authoritative contract for the messaging bridge. Switches over the union carry `default` returns (`stream-mapper.ts`, `StreamAdapter.ts`, `DefaultConversationEventLog.ts`), so the addition is non-breaking; `typecheck:all` is the gate.
