# WhatsApp Pharmacy Ordering Edge-Case Gap Analysis

Verdict: **not ready** for production WhatsApp pharmacy ordering.

The implementation proves a narrow demo path: signed webhook ingress, text/image prescription input, cart tools, a suspend/resume payment link, and cart clearing after confirmation. Production gaps are concentrated around payment/order state, WhatsApp platform mechanics, compliance, and deterministic conversation control.

Research sources used inline include Meta/WhatsApp official docs for service messages, templates, media, error codes, and policy; Hookdeck's 2026 WhatsApp webhook reliability guide; Twilio's WhatsApp concepts/media docs; Wati and Respond.io operational write-ups.

## Review Scope And Evidence

Code read:

- App: `apps/playground/pharmacy-rx-agent/src/index.ts`, `pharmacy.ts`, `wa-agent.ts`, `wa-turn.ts`, `wa-session-store.ts`, `token.ts`, `inventory.ts`, `wa.test.ts`.
- SDK source: `packages/messaging/src/**`, `packages/messaging-meta/src/**`, with focused full-file reads for webhook normalization, WhatsApp client, commerce, error classification, router, dedup, coalescing, consent, window guard, media attachment, and stream mapping.
- SDK tests/examples read where they prove relevant behavior: deduplication, coalescing, consent STOP, window guard, webhook normalizer, Graph API errors, WhatsApp commerce.

Tests run:

- `bun test apps/playground/pharmacy-rx-agent/src/wa.test.ts` -> 7 pass.
- `bun test packages/messaging/test/deduplicator.test.ts packages/messaging/test/inbound-coalescing-router.test.ts packages/messaging/test/consent-stop.test.ts packages/messaging/test/window-guard.test.ts` -> 19 pass.
- `bun test packages/messaging-meta/test/webhook-normalizer.test.ts packages/messaging-meta/test/graph-api-errors.test.ts packages/messaging-meta/test/whatsapp-commerce.test.ts` -> 70 pass.

No tests were added because this was read-only research/report work.

## Summary Table

| Category | # gaps | Highest severity |
|---|---:|---|
| Cart/order lifecycle | 10 | P0 |
| Conversation control | 8 | P0 |
| Messaging mechanics | 11 | P0 |
| Multimodal edge cases | 6 | P1 |
| Commerce and pharmacy domain | 9 | P0 |
| Identity/session | 4 | P1 |
| Reliability/operations | 9 | P0 |
| Compliance/security/audit | 8 | P0 |

## User-Lens Checks

- Ideal user: can send text or one image and pay once; this is grounded by `wa-turn.ts:76-82`, `pharmacy.ts:201-231`, and passing `wa.test.ts`. The path breaks once they need delivery address, order tracking, cancel/modify, or failed payment handling.
- Hard-sell user: rejects the bot because checkout emits a demo URL, not a real payment/provider state machine (`pharmacy.ts:213-225`, `index.ts:103-117`), and cannot answer "where is my order" beyond `lastOrder` being private state (`pharmacy.ts:194-195`).
- Bad user: can forge or reuse payment tokens because the token is explicitly an unsigned base64url JSON blob (`token.ts:6-8`, `token.ts:23-30`); can request quantities above stock because `add_to_cart` only checks `stock <= 0`, not requested quantity (`pharmacy.ts:89-106`).
- Disappointed user: sends PDF/audio/second image/reaction/status-related follow-up and gets no deterministic handling because app input builder only handles `message.image` and text (`wa-turn.ts:23-39`) while the webhook route ignores `events.statuses`, `events.reactions`, and `events.errors` (`index.ts:85-97`).

## Cart/Order Lifecycle

1. **Partial/failed payment** - payment providers fail, authorize partially, or return pending; otherwise users see false confirmations or no recovery. Our handling: ❌ missing. `/wa-pay` only decodes a token and sends `{ paid: true }` (`index.ts:103-117`, `wa-turn.ts:96-99`); no provider callback, status, amount, currency, failure reason, or pending state exists. Severity: P0. Recommended handling: introduce `Order` and `PaymentIntent` records with states `cart -> checkout_pending -> payment_pending -> paid -> failed/expired/cancelled/refunded`, and resume only from verified provider webhooks.

2. **Payment link expiry** - stale payment links can confirm old carts or confuse users. Our handling: ❌ missing. Token has only `doId` and `signalId` (`token.ts:10-15`) and decode validates only string fields (`token.ts:27-30`). Severity: P0. Recommended handling: store opaque checkout token with `expiresAt`, order snapshot, amount, and one-time status; reject expired links with a WhatsApp recovery template if needed.

3. **Payment token forgery** - attacker can create a base64 JSON token and signal arbitrary checkout ids. Our handling: ❌ missing. Comment says "DEMO-GRADE" and "not signed" (`token.ts:6-8`); `/wa-pay` trusts decoded values (`index.ts:103-113`). Severity: P0. Recommended handling: sign/encrypt tokens or use random server-side token ids bound to user/order/payment intent.

4. **Double checkout / multiple active payment links** - users can ask to pay twice or click old links after cart changes. Our handling: ⚠️ partial. The flow suppresses duplicate link emission using `paymentLinkSent` (`pharmacy.ts:217-227`) and durable resume is intended idempotent (`wa-turn.ts:85-99`), but there is no order id, token status, cart snapshot, or invalidation of older links. Severity: P1. Recommended handling: one active checkout per user/cart version; invalidate old links when cart mutates.

5. **Order status / "where is my order"** - pharmacy commerce requires tracking after payment. Our handling: ❌ missing. `orderComplete` creates a random `orderNo` and stores `lastOrder` in session state (`pharmacy.ts:184-195`) but there is no query tool, shipment state, status webhook, or outbound update template. Severity: P1. Recommended handling: persist order records and add `get_order_status`/status notification templates.

6. **Cancel/modify after checkout** - users commonly change cart/address after link but before payment. Our handling: ❌ missing. Mutating tools exist (`pharmacy.ts:256-258`), but checkout waits only for `PAYMENT_SIGNAL` (`pharmacy.ts:229-231`); no cancel/modify signal or state transition exists. Severity: P1. Recommended handling: add cancel/modify commands that cancel active payment intents and create a new checkout.

7. **Refunds** - paid orders may be refunded or rejected by pharmacist. Our handling: ❌ missing. `orderComplete` immediately says order "is confirmed and will be dispatched" (`pharmacy.ts:190-193`), with no refund/reversal state. Severity: P1. Recommended handling: separate payment capture from pharmacist fulfillment approval; support refund status and notifications.

8. **Cart cleared only on successful payment** - the implemented happy path does this. Our handling: ✅ handled for `paid=true` only. `state.cart = []` and `paymentLinkSent = false` in `orderComplete` (`pharmacy.ts:194-196`); the SQLite store preserves session/durable journal (`wa-session-store.ts:32-48`, `wa.test.ts:113-135`). Severity: P2. Recommended handling: retain this but tie it to real order/payment state.

9. **Cart abandonment / return after 24h** - in-progress per brief but not visible in app code. Our handling: ❌ missing in current code. `rg` found no abandonment/resume/fresh logic in app; only prompt text covers completed orders (`pharmacy.ts:167-170`). Severity: P1. Recommended handling: store cart `updatedAt`, detect return after inactivity, offer "resume cart" / "start fresh" via buttons or template.

10. **Stock reservation and decrement** - checkout can oversell static stock. Our handling: ❌ missing. `INVENTORY` is static (`inventory.ts:20-36`); `add_to_cart` never decrements or reserves stock and accepts any positive quantity (`pharmacy.ts:89-106`). Severity: P0. Recommended handling: reserve at checkout, revalidate before payment, decrement on paid, release on expiry/cancel.

## Conversation Control

1. **Cancel / start over / clear cart** - users need an escape hatch. Our handling: ⚠️ partial. `remove_from_cart` exists (`pharmacy.ts:110-119`), but there is no deterministic handler for "cancel", "clear cart", or cancelling a suspended checkout; it depends on model interpretation. Severity: P1. Recommended handling: intercept control intents before model or add hard tools/signals for `cancel_checkout`, `clear_cart`, `start_over`.

2. **STOP / opt-out policy** - WhatsApp best practice requires respecting opt-outs; Wati recommends clear opt-out and prompt handling (https://support.wati.io/en/articles/11462891-get-the-most-out-of-wati-with-these-whatsapp-messaging-best-practices). Our handling: ❌ missing in app. SDK has `ConsentStore` (`packages/messaging/src/adapter/consent-store.ts:1-6`) and router STOP logic (`packages/messaging/src/adapter/createMessagingRouter.ts:130-133`), but app bypasses router and processes every message (`index.ts:85-97`, `wa-agent.ts:51-55`). Severity: P0. Recommended handling: add durable consent store and STOP/START intercept in pharmacy app path.

3. **Talk to human / complaint / pharmacist review** - pharmacy and complaints require escalation. Our handling: ❌ missing. SDK has an ownership concept (`packages/messaging/src/adapter/ownership-store.ts:1-8`) and router can claim human ownership on handoff parts (`packages/messaging/src/adapter/createMessagingRouter.ts:137-139`, `168-173`), but pharmacy app never configures ownership or handoff. Severity: P0. Recommended handling: implement human handoff state, suppress bot while human owns thread, persist transcript and reason.

4. **Off-topic mid-flow** - users may ask unrelated questions during checkout. Our handling: ⚠️ partial. Prompt asks for short WhatsApp replies and trust tools (`pharmacy.ts:138-171`), but checkout flow has no mid-flow branch except payment signal (`pharmacy.ts:229-231`). Severity: P2. Recommended handling: allow Q&A during checkout without mutating cart, and support explicit resume/cancel.

5. **Language switch** - users may switch languages. Our handling: ❌ missing. No locale/language state appears in app route or prompt; model may improvise only. Severity: P2. Recommended handling: detect language per turn, persist preferred language, use localized templates.

6. **Gibberish/ambiguous input** - LLM may hallucinate intent or add items incorrectly. Our handling: ⚠️ partial. Prompt says greetings/closings are not commands (`pharmacy.ts:153-157`) and add only current-message medicines (`pharmacy.ts:153-161`), but no validation layer rejects low-confidence OCR or gibberish. Severity: P1. Recommended handling: add deterministic confidence/clarification policy before cart mutation.

7. **Repeated complaints after bot failure** - should stop automated loop and escalate. Our handling: ❌ missing. `runWhatsAppTurn` sends model output if any (`wa-turn.ts:79-82`); no failure counter or sentiment/complaint escalation exists. Severity: P1. Recommended handling: track repeated fallback/negative sentiment and route to human.

8. **User asks to delete data / privacy request** - healthcare users may request deletion/export. Our handling: ❌ missing. `SqlSessionStore` can delete by id (`wa-session-store.ts:51-53`) but no command path invokes it. Severity: P1. Recommended handling: add privacy command workflow and human review.

## Messaging Mechanics

1. **24h customer-service window expiry** - WhatsApp free-form messages are allowed only during the customer service window; outside it, approved templates are required (Meta service messages: https://developers.facebook.com/documentation/business-messaging/whatsapp/messages/send-messages; Twilio concepts: https://www.twilio.com/docs/whatsapp/key-concepts). Our handling: ❌ missing in app. App calls raw `sendText` (`wa-turn.ts:81`); `WhatsAppClient.sendText` sends free-form text directly (`packages/messaging-meta/src/whatsapp/client.ts:166-172`, `980-989`). SDK window guard exists (`packages/messaging/src/adapter/middleware/window-guard.ts:3-12`) but app does not use `createMessagingRouter`. Severity: P0. Recommended handling: route through window store/guard and template fallback.

2. **Template re-engagement and template rejection** - templates are required outside the window and can be rejected/paused (Meta templates: https://developers.facebook.com/documentation/business-messaging/whatsapp/templates/overview). Our handling: ❌ missing in app. Client can send/list templates (`packages/messaging-meta/src/whatsapp/client.ts:292-305`, `639-680`), but webhook route ignores template status fields and only normalizes `messages` field (`index.ts:85-97`; normalizer only handles `change.field === 'messages'` at `packages/messaging-meta/src/webhook/normalizer.ts:328-330`). Severity: P1. Recommended handling: maintain approved template inventory, handle template lifecycle webhooks, and fail closed.

3. **Duplicate webhook delivery / Meta retries** - WhatsApp webhooks are at-least-once; Hookdeck documents duplicate delivery and recommends idempotency by message id (https://hookdeck.com/webhooks/platforms/guide-to-whatsapp-webhooks-features-and-best-practices). Our handling: ❌ missing in app. App loops all `events.messages` and enqueues each (`index.ts:86-95`) with no dedup check. SDK has in-memory `MessageDeduplicator` (`packages/messaging/src/shared/deduplicator.ts:6-16`) and tests (`packages/messaging/test/deduplicator.test.ts:4-14`), but it is not wired. Severity: P0. Recommended handling: durable per-message idempotency table keyed by WhatsApp message id.

4. **Out-of-order delivery** - webhooks have no ordering guarantee; Hookdeck recommends using timestamps and idempotent state machines (https://hookdeck.com/webhooks/platforms/guide-to-whatsapp-webhooks-features-and-best-practices). Our handling: ❌ missing. App dispatches each normalized message immediately via `ctx.waitUntil` (`index.ts:86-95`), and DO runs each as a turn (`wa-agent.ts:51-55`) without timestamp ordering or stale-message handling. Severity: P1. Recommended handling: per-user durable queue sorted by timestamp with stale policy.

5. **Rapid multi-message bursts / coalescing** - users send image then caption or fragmented instructions. Our handling: ❌ missing in app. Generic router supports coalescing (`packages/messaging/src/adapter/createMessagingRouter.ts:110-120`, `205-208`) and tests image+caption merge (`packages/messaging/test/inbound-coalescing-router.test.ts:128-164`), but pharmacy app bypasses it and runs one message at a time (`wa-turn.ts:76-82`). Severity: P1. Recommended handling: enable per-user coalescing before runtime.run.

6. **Message status callbacks (`sent`, `delivered`, `read`, `failed`)** - failed sends carry errors such as 131047 and should drive recovery. Our handling: ❌ missing in app. Normalizer surfaces statuses (`packages/messaging-meta/src/webhook/normalizer.ts:406-431`) and tests failed status errors (`packages/messaging-meta/test/webhook-normalizer.test.ts:362-395`), but app ignores `events.statuses` (`index.ts:85-97`). Severity: P1. Recommended handling: persist outbound message ids and process status webhooks, especially `failed`.

7. **Webhook-level errors** - account-level `value.errors` should alert operators. Our handling: ❌ missing. Normalizer collects errors (`packages/messaging-meta/src/webhook/normalizer.ts:402-404`, `606-620`), app ignores `events.errors` (`index.ts:85-97`). Severity: P1. Recommended handling: alert and dead-letter webhook errors with phone number id.

8. **Reactions** - users may react instead of replying. Our handling: ❌ missing. Normalizer splits reactions into `events.reactions` (`packages/messaging-meta/src/webhook/normalizer.ts:345-356`), and tests prove this (`packages/messaging-meta/test/webhook-normalizer.test.ts:260-295`), but app ignores reactions (`index.ts:85-97`). Severity: P2. Recommended handling: either no-op reactions deliberately or map thumbs-up/negative reactions to confirmation/escalation.

9. **Reply/quoted context** - users reply to a specific previous item or product. Our handling: ⚠️ partial in SDK, missing in app behavior. Normalizer preserves context (`packages/messaging-meta/src/webhook/normalizer.ts:379-396`), but `buildWhatsAppInput` uses only text/image caption (`wa-turn.ts:23-39`) and discards context. Severity: P1. Recommended handling: include quoted message id/product context in model input or deterministic resolver.

10. **Unsupported/system/edited message types** - Cloud API may deliver non-text message events; users expect a clear fallback. Our handling: ❌ missing. Normalizer maps unknown types (`packages/messaging-meta/src/webhook/normalizer.ts:358-363`), but `buildWhatsAppInput` returns `null` unless text or image exists (`wa-turn.ts:23-39`), causing silent no-reply (`wa-turn.ts:76-78`). Severity: P2. Recommended handling: send an explicit unsupported-type message and log the raw type.

11. **Webhook retry storm capacity** - Hookdeck notes retries/backoff and burst risk when endpoints recover (https://hookdeck.com/webhooks/platforms/guide-to-whatsapp-webhooks-features-and-best-practices). Our handling: ⚠️ partial. App returns 200 before model work (`index.ts:76-97`) which is good, but there is no durable queue, DLQ, replay, or dedup. Severity: P1. Recommended handling: enqueue webhook events durably before ack or combine immediate ack with durable per-user message ledger.

## Multimodal Edge Cases

1. **PDF prescription/document** - many e-prescriptions arrive as PDFs. Our handling: ❌ missing in app. Normalizer captures `document` (`packages/messaging-meta/src/webhook/normalizer.ts:371-372`); generic SDK can attach documents (`packages/messaging/src/adapter/inbound-media.ts:21-58`); app only handles `message.image` (`wa-turn.ts:26-37`). Severity: P1. Recommended handling: support `document` PDFs with MIME/size validation and OCR/PDF extraction.

2. **Audio note** - users may dictate medicine names or symptoms. Our handling: ❌ missing in app. Normalizer captures audio (`packages/messaging-meta/src/webhook/normalizer.ts:371`); app ignores it and returns `null` without reply (`wa-turn.ts:23-39`, `76-78`). Severity: P2. Recommended handling: transcribe audio or reply with supported input instructions.

3. **Multiple images / image + caption burst** - prescription pages often span multiple photos. Our handling: ❌ missing in app. Each webhook message is fanned out independently (`index.ts:86-95`); app has no coalescing. Severity: P1. Recommended handling: coalesce within a short window and merge files into one model turn.

4. **Oversized media / unsupported MIME** - Meta/Twilio document media size/type limits; Twilio lists image/audio/document/video MIME classes and size constraints (https://www.twilio.com/docs/whatsapp/guidance-whatsapp-media-messages), Meta media docs note Cloud API media handling (https://developers.facebook.com/documentation/business-messaging/whatsapp/business-phone-numbers/media/). Our handling: ❌ missing. App downloads media and base64s it without size/type checks (`wa-turn.ts:26-35`). Severity: P1. Recommended handling: reject unsupported/oversized media before model and ask for clear JPG/PNG/PDF.

5. **Blurry/unreadable prescription** - model may infer incorrectly. Our handling: ❌ missing. Prompt says read image and identify medicines (`pharmacy.ts:142-144`) but no confidence threshold, pharmacist review, or "cannot read" guard exists. Severity: P0 for pharmacy safety. Recommended handling: require explicit low-confidence clarification and pharmacist/human verification before dispensing.

6. **Media download failure** - CDN link may expire or Graph call may fail. Our handling: ❌ missing. `buildWhatsAppInput` awaits `downloadMedia` without try/catch (`wa-turn.ts:26-35`); `runWhatsAppTurn` has no catch (`wa-turn.ts:70-82`). Severity: P1. Recommended handling: catch media errors, send retry guidance, and log failed media ids.

## Commerce And Pharmacy Domain

1. **Delivery address collection** - every order needs fulfillment address or pickup choice. Our handling: ❌ missing. SDK supports address messages (`packages/messaging-meta/src/whatsapp/client.ts:552-583`) and parsing (`packages/messaging-meta/src/whatsapp/commerce.ts:81-114`), but pharmacy checkout does not ask/store address (`pharmacy.ts:201-231`). Severity: P0. Recommended handling: collect address/pickup before payment using validated fields and country availability fallback.

2. **Meta catalog/order messages** - WhatsApp commerce orders may arrive as `type: order`. Our handling: ❌ missing in app. Normalizer surfaces `order` (`packages/messaging-meta/src/webhook/normalizer.ts:377-378`), SDK parses it (`packages/messaging-meta/src/whatsapp/commerce.ts:48-79`), but app input builder discards order payloads (`wa-turn.ts:23-39`). Severity: P1. Recommended handling: either disable catalog order paths or map inbound `order.product_items` into cart workflow.

3. **Using WhatsApp commerce for medicines** - WhatsApp policy restricts commerce/payment experiences for OTC/prescription drug exchange; policy sources state businesses must follow applicable law and avoid prohibited health-related uses (WhatsApp Business Messaging Policy: https://whatsappbusiness.com/policy/; policy coverage examples: https://www.haptik.ai/blog/whatsapp-business-messaging-regulated-sectors). Our handling: ❌ missing. Bot directly facilitates medicine order/payment (`pharmacy.ts:163-165`, `213-225`) and inventory includes prescription drugs (`inventory.ts:21-35`). Severity: P0. Recommended handling: legal/policy review before launch; gate commerce to allowed products/regions or turn flow into reservation/request-for-pharmacist-contact rather than sale.

4. **Prescription-required enforcement** - rxRequired is surfaced but not enforced. Our handling: ⚠️ partial. Inventory has `rxRequired` (`inventory.ts:16-17`) and `check_inventory` returns it (`pharmacy.ts:63-70`), but `add_to_cart` ignores it (`pharmacy.ts:89-106`). Severity: P0. Recommended handling: require valid prescription evidence and pharmacist review before adding/checkout for rx items.

5. **Controlled substances / age restriction** - some medicines require special controls. Our handling: ❌ missing. Inventory has only `rxRequired` and no schedule/age/region fields (`inventory.ts:5-18`). Severity: P0. Recommended handling: add regulatory classification, age/identity verification, and block disallowed SKUs.

6. **Quantity and dosage limits** - users can add excessive quantities. Our handling: ❌ missing. Quantity schema is any positive integer (`pharmacy.ts:85-88`) and tool adds it without stock/max checks (`pharmacy.ts:96-106`). Severity: P0. Recommended handling: enforce stock, legal max, refill cadence, prescription quantity, and pharmacist override.

7. **Out-of-stock discovered mid-checkout** - stock can change between cart and payment. Our handling: ❌ missing. Checkout reads cart only (`pharmacy.ts:204-225`) and never re-checks `INVENTORY` or live stock. Severity: P1. Recommended handling: revalidate and reserve stock immediately before issuing payment.

8. **Substitution consent** - alternative medicines/strengths require explicit consent. Our handling: ⚠️ partial. Prompt says offer at most one alternative (`pharmacy.ts:146-147`), but no durable consent field is stored per substitution. Severity: P1. Recommended handling: store explicit accepted substitution line item and pharmacist review.

9. **Payment provider failure/timeout** - external checkout systems fail independently from WhatsApp. Our handling: ❌ missing. Payment is a local link that always resumes paid on click (`index.ts:108-113`, `wa-turn.ts:96-99`). Severity: P0. Recommended handling: integrate real PSP webhooks with retry/timeout/reconciliation.

## Identity/Session

1. **Same user across devices** - WhatsApp may deliver to multiple devices; delivery failures can be device-specific (Meta support docs: https://developers.facebook.com/documentation/business-messaging/whatsapp/support). Our handling: ⚠️ partial. Session key is WhatsApp sender id (`index.ts:87-89`, `wa-agent.ts:21-24`) so devices for same number converge, but status errors are ignored. Severity: P2. Recommended handling: rely on wa_id for session, but process delivery failures and avoid device assumptions.

2. **Number reassignment / changed number system events** - a phone number can later belong to a different person. Our handling: ❌ missing. Session DO id is `wa:${from}` (`index.ts:87-89`) and session persists indefinitely (`wa-session-store.ts:32-48`); no system/change-number handling or retention expiry exists. Severity: P1. Recommended handling: expire old sessions, detect system messages, and require re-auth/consent for sensitive order history.

3. **Blocked or unreachable user** - sends can fail with recipient errors. Our handling: ❌ missing. Error classifier maps 131026 to `RecipientError` (`packages/messaging-meta/src/graph-api/errors.ts:110-113`), but app does not catch send errors (`wa-turn.ts:79-82`) or process failed statuses (`index.ts:85-97`). Severity: P1. Recommended handling: mark contact unreachable and stop automated retries.

4. **Multi-tenant/phone number routing** - multiple phone numbers need isolation. Our handling: ⚠️ partial. Normalized messages include `phoneNumberId` (`packages/messaging-meta/src/webhook/normalizer.ts:52-53`), but app keys Durable Objects only by sender `from` (`index.ts:87-89`), not phone number id. Severity: P1. Recommended handling: key sessions by `phoneNumberId:from` and tenant.

## Reliability/Operations

1. **Model timeout / runtime error mid-turn** - user gets silence and operator gets no structured alert. Our handling: ❌ missing. `runWhatsAppTurn` has no try/catch around `runtime.run`, stream drain, or `sendText` (`wa-turn.ts:76-82`); DO handler awaits it directly (`wa-agent.ts:51-55`). Severity: P1. Recommended handling: catch errors, send fallback through window-aware path, emit structured error event.

2. **DO eviction during suspended checkout** - this specific case is handled. Our handling: ✅ handled for durable journal persistence. SQLite store serializes full session (`wa-session-store.ts:43-48`) and test verifies durableRuns survives (`wa.test.ts:113-135`). Severity: P2. Recommended handling: keep, but add migration/versioning for order schemas.

3. **Access token expiry / error 190** - outbound sends stop. Our handling: ⚠️ partial SDK classification, missing app recovery. Classifier maps code 190 to `AuthenticationError` (`packages/messaging-meta/src/graph-api/errors.ts:90-93`) and tests it (`packages/messaging-meta/test/graph-api-errors.test.ts:62-72`), but app has no alert/secret rotation flow. Severity: P0. Recommended handling: health checks, alerting, token rotation runbook, and queue outbound until fixed.

4. **Meta rate limiting 130429 / pair limit 131056** - production send volume and per-user bursts need backoff. Hookdeck notes throughput and pair-rate limits, including 130429 and one message per six seconds per user (https://hookdeck.com/webhooks/platforms/guide-to-whatsapp-webhooks-features-and-best-practices). Our handling: ⚠️ partial/incomplete. Classifier handles HTTP 429 and codes 4/32/613 only (`packages/messaging-meta/src/graph-api/errors.ts:85-88`), not 130429/131056; app has no retry queue. Severity: P0. Recommended handling: classify WhatsApp-specific rate codes, per-recipient throttling, durable retry/backoff queue.

5. **Template rejection/paused status** - re-engagement can silently fail. Our handling: ❌ missing. Template list maps `paused` (`packages/messaging-meta/src/whatsapp/client.ts:1018-1032`), but app never checks/listens to template lifecycle. Severity: P1. Recommended handling: template health monitor and deployment gate.

6. **Unhandled `ctx.waitUntil` failures** - webhook returns OK even if downstream DO fails. Our handling: ❌ missing observability. App schedules DO fetch in `ctx.waitUntil` without `.catch` or logging (`index.ts:89-95`). Severity: P1. Recommended handling: wrap waitUntil with error logging and durable dead-letter.

7. **No health endpoint for WhatsApp app path** - cannot know Graph/token/template health. Our handling: ❌ missing. Default fetch only handles webhook/pay/agent routing (`index.ts:60-150`); no health route. Severity: P2. Recommended handling: add `/health` checking token, phone number, templates, and queue lag.

8. **Message splitting/formatting** - long WhatsApp text is split by client but pharmacy-specific markdown sanitizer is separate. Our handling: ✅ partial. `toWhatsAppText` converts Markdown basics (`wa-turn.ts:49-58`); client `sendText` splits to 4096 (`packages/messaging-meta/src/whatsapp/client.ts:161-172`). Severity: P2. Recommended handling: keep, but route through platform converter/window guard consistently.

9. **No audit/observability of order state transitions** - cannot reconcile money, cart, or drug dispense decisions. Our handling: ❌ missing. Only session JSON persists (`wa-session-store.ts:32-48`); no append-only order/payment audit log. Severity: P0. Recommended handling: append-only order/payment/action ledger with correlation ids.

## Compliance/Security/Audit

1. **Health data / PHI handling** - WhatsApp policy requires legal compliance and warns against health-related information where regulations prohibit it (https://whatsappbusiness.com/policy/); HIPAA/GDPR/local pharmacy rules may apply. Our handling: ❌ missing. Prescription images are downloaded and persisted into runtime/session as base64 file parts (`wa-turn.ts:26-35`; session store JSON persists session data `wa-session-store.ts:43-48`). Severity: P0. Recommended handling: legal review, DPA/BAA posture, consent, retention, encryption, redaction, and data minimization.

2. **Privacy policy / notices / consent capture** - required for collecting/sharing user content. Our handling: ❌ missing. No consent prompt/state in app; `ConsentStore` exists only as SDK interface (`packages/messaging/src/adapter/consent-store.ts:1-6`). Severity: P0. Recommended handling: first-contact consent/notice flow and durable consent ledger.

3. **Payment card / sensitive identifier policy** - WhatsApp policy says not to request full payment card or sensitive identifiers (https://whatsappbusiness.com/policy/). Our handling: ⚠️ partial. The demo emits external payment link (`pharmacy.ts:222-225`) and does not ask for card details, but link is unsigned (`token.ts:6-8`). Severity: P1. Recommended handling: keep card entry out of WhatsApp; use signed PSP hosted checkout.

4. **Prescription drug commerce policy** - regulated goods/medicine commerce may be restricted. Our handling: ❌ missing. Inventory includes prescription medicines (`inventory.ts:21-35`) and bot sells them via checkout. Severity: P0. Recommended handling: convert to pre-order/pharmacist contact flow until legal/policy clearance.

5. **Pharmacist verification/audit trail** - dispensing decisions need human accountability. Our handling: ❌ missing. Model can read prescription and call add-to-cart (`pharmacy.ts:142-145`, `82-107`) without human approval. Severity: P0. Recommended handling: require pharmacist approval before checkout for rxRequired items.

6. **Data retention and deletion** - prescription/order history should not persist indefinitely. Our handling: ❌ missing. Sessions are stored with no TTL (`wa-session-store.ts:32-48`) and `delete` is unused (`wa-session-store.ts:51-53`). Severity: P1. Recommended handling: retention policy, scheduled deletion, user deletion workflow.

7. **Access control for payment callback** - any holder of token can trigger payment. Our handling: ❌ missing. `/wa-pay/:token` uses no authentication besides token contents (`index.ts:103-117`). Severity: P0. Recommended handling: server-side one-time opaque token + PSP signature verification.

8. **Transcript forwarding / cross-customer leakage** - policy prohibits sharing customer chat with others. Our handling: ⚠️ partial. Sessions are per `wa:${from}` (`index.ts:87-89`), but phone-number-only key and number reassignment risk could expose history to a future owner. Severity: P1. Recommended handling: TTL sessions, re-consent, and identity freshness checks.

## Top 10 To Fix First

1. Replace demo payment link with server-side order/payment-intent state and PSP webhook verification.
2. Add durable idempotency for inbound WhatsApp message ids before any runtime/cart mutation.
3. Implement 24h window tracking plus approved template fallback/re-engagement.
4. Add pharmacy compliance gate: legal policy review, rxRequired enforcement, pharmacist approval, and medicine commerce restrictions.
5. Add stock reservation/revalidation and quantity/legal limit enforcement.
6. Add deterministic STOP/START, cancel/start-over, clear-cart, and human-handoff intercepts.
7. Support delivery address/pickup collection before payment.
8. Process status/error webhooks and add outbound retry/backoff for 190, 130429, 131056, 131047, and failed statuses.
9. Support PDF/document and multi-image prescription intake with confidence/fallback.
10. Add order records/status/cancel/refund lifecycle and user-facing order-status tool.

## WBS

| ID | Task | Grounding | Acceptance criteria | Owner |
|---|---|---|---|---|
| WA-01 | Implement durable inbound message idempotency before `runtime.run`. | Messaging gap 3; `index.ts:86-95`; SDK `deduplicator.ts:6-16`. | Duplicate Meta webhook with same `messages[].id` produces one cart mutation and one reply across DO restarts. | impl |
| WA-02 | Introduce `Order` and `PaymentIntent` state machine with opaque signed/server-side checkout tokens. | Cart gaps 1-4; `token.ts:6-8`; `index.ts:103-117`. | Payment can be `pending/paid/failed/expired/cancelled/refunded`; forged/expired/replayed tokens do not confirm an order. | impl |
| WA-03 | Integrate real PSP webhook verification and reconciliation. | Cart gap 1; Commerce gap 9. | `/wa-pay` no longer marks paid directly; verified PSP webhook with matching amount/currency/order id is required. | impl |
| WA-04 | Add stock reservation, stock decrement, and quantity limits. | Cart gap 10; Commerce gaps 6-7; `pharmacy.ts:89-106`. | Attempting quantity above stock/legal max is rejected; checkout reserves stock; expiry/cancel releases it. | impl |
| WA-05 | Gate prescription-required SKUs behind prescription evidence and pharmacist approval. | Compliance gap 5; `inventory.ts:16-17`; `pharmacy.ts:63-70`, `89-106`. | `rxRequired` items cannot checkout until verified prescription and pharmacist approval are recorded. | impl/human |
| WA-06 | Build WhatsApp 24h window store and template fallback into pharmacy app path. | Messaging gaps 1-2; app direct send `wa-turn.ts:81`; SDK window guard `window-guard.ts:3-12`. | Free-form outbound outside window is blocked; approved utility template is sent for allowed re-engagement. | impl |
| WA-07 | Process `statuses`, `reactions`, and `errors` from normalized webhooks. | Messaging gaps 6-8; `normalizer.ts:406-431`; `index.ts:85-97`. | Failed status updates persist error code/message and trigger recovery/alert; reactions are explicitly handled or no-op logged. | impl |
| WA-08 | Add durable per-user inbound queue with timestamp ordering and burst coalescing. | Messaging gaps 4-5; `index.ts:86-95`; router coalescing `createMessagingRouter.ts:110-120`. | Image+caption and multi-text bursts merge into one turn; stale/out-of-order messages do not mutate current checkout incorrectly. | impl |
| WA-09 | Support PDF/document prescription input with media validation. | Multimodal gaps 1 and 4; `wa-turn.ts:23-39`; SDK `inbound-media.ts:21-58`. | PDF under allowed size reaches model/OCR; oversized/unsupported media gets a clear WhatsApp reply and no model call. | impl |
| WA-10 | Support multi-image prescription batches and low-confidence OCR fallback. | Multimodal gaps 3 and 5. | Multi-page prescription photos are interpreted together; unreadable/low-confidence prescriptions request a clearer image or human review. | impl |
| WA-11 | Add deterministic conversation controls: STOP/START, cancel checkout, clear cart, start over. | Conversation gaps 1-2; `pharmacy.ts:110-119`; `createMessagingRouter.ts:130-133`. | Commands are handled before LLM; STOP suppresses non-transactional outbound; cancel invalidates active payment intent. | impl |
| WA-12 | Add human handoff with bot suppression and transcript handoff. | Conversation gap 3; `ownership-store.ts:1-8`; router handoff `createMessagingRouter.ts:137-139`. | "human", complaints, repeated failures, and pharmacist-review needs assign thread to human and bot stays silent until release. | impl |
| WA-13 | Collect delivery address or pickup choice before payment. | Commerce gap 1; SDK address support `whatsapp/client.ts:552-583`, `commerce.ts:81-114`. | Checkout cannot create payment until address/pickup is validated and stored on the order. | impl |
| WA-14 | Add order status/cancel/refund tools and outbound status templates. | Cart gaps 5-7; `pharmacy.ts:184-195`. | User can ask "where is my order"; cancel/refund flows update order state and send compliant notifications. | impl |
| WA-15 | Key WhatsApp sessions by tenant/phoneNumberId/from and add session TTL/re-consent. | Identity gaps 2 and 4; `index.ts:87-89`; `normalizer.ts:52-53`. | Same `from` across different business phone numbers cannot share state; expired sessions require renewed consent before revealing history. | impl |
| WA-16 | Add Graph error classification for WhatsApp-specific operational codes and durable retry queue. | Reliability gaps 3-4; `errors.ts:85-93`, `110-117`. | 190 alerts auth; 130429/131056 back off; 131047 routes template fallback; retries survive Worker/DO restarts. | impl |
| WA-17 | Add `/health` and alerting for token, phone number, template status, queue lag, and failed sends. | Reliability gaps 5-7; `index.ts:60-150`. | Health endpoint returns non-200 for expired token/unapproved template/queue backlog; alerts include phoneNumberId and error code. | impl |
| WA-18 | Create append-only audit ledger for cart, prescription, pharmacist, payment, and order transitions. | Reliability gap 9; Compliance gaps 1, 5, 6. | Each order has immutable events with actor, timestamp, correlation id, and before/after state. | impl |
| WA-19 | Implement privacy/consent/retention workflow. | Compliance gaps 1-2 and 6; `wa-session-store.ts:43-53`. | First contact shows notice; consent is stored; delete/export request removes or exports user data according to policy. | impl/human |
| WA-20 | Complete legal policy review for WhatsApp pharmacy commerce before enabling checkout. | Commerce gap 3; Compliance gap 4; WhatsApp policy URLs. | Human-approved policy decision documents allowed products/regions/flows; disallowed flows are feature-gated. | human |

## Web Sources

- Meta service messages / customer service window: https://developers.facebook.com/documentation/business-messaging/whatsapp/messages/send-messages
- Meta template overview: https://developers.facebook.com/documentation/business-messaging/whatsapp/templates/overview
- Meta error codes: https://developers.facebook.com/documentation/business-messaging/whatsapp/support/error-codes
- Meta media docs: https://developers.facebook.com/documentation/business-messaging/whatsapp/business-phone-numbers/media/
- WhatsApp Business Messaging Policy: https://whatsappbusiness.com/policy/
- Hookdeck WhatsApp webhook best practices, retries, dedup, ordering, capacity: https://hookdeck.com/webhooks/platforms/guide-to-whatsapp-webhooks-features-and-best-practices
- Twilio WhatsApp customer service windows/templates: https://www.twilio.com/docs/whatsapp/key-concepts
- Twilio WhatsApp media guidance: https://www.twilio.com/docs/whatsapp/guidance-whatsapp-media-messages
- Wati WhatsApp messaging best practices / opt-out: https://support.wati.io/en/articles/11462891-get-the-most-out-of-wati-with-these-whatsapp-messaging-best-practices
- Respond.io WhatsApp chatbot operations: https://respond.io/blog/whatsapp-chatbot
- Haptik regulated WhatsApp sectors summary: https://www.haptik.ai/blog/whatsapp-business-messaging-regulated-sectors

## Unverified Items

- I did not run a live WhatsApp webhook, Graph API send, PSP callback, or browser/UI flow; this was code + docs research.
- I did not verify jurisdiction-specific pharmacy law for the target deployment region. WA-20 must be human/legal-owned before production checkout.
- The app tree already had uncommitted source changes before this review; I did not modify source files.
