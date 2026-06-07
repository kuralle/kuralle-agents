# Pharmacy example — prescription refill bot

Deep example for `@kuralle-agents/engagement`: **free-form extraction**, **consent / STOP**, **human handoff**, **copay approval** (`needsApproval`), and **template-based proactive refill reminders** (closed window → template).

## Flow (`acme-pharmacy` / `rx-refill`)

1. **greet** — demo disclaimer (no real PHI) → **verifyIdentity**
2. **verifyIdentity** — extract `fullName`, `dob` (YYYY-MM-DD) → **verifyMatch**
3. **verifyMatch** — mock `verifyPatient`; no match → **noMatch** / `{ end: 'no-match' }`
4. **chooseRx** — buttons by stable id (`rx-amox`, `rx-lis`) → **interactionCheck**
5. **interactionCheck** — mock `checkInteractions` → **insurance**
6. **insurance** — extract insurer / member id / pay cash → **fulfilment**
7. **fulfilment** — `pickup` → **payment**; `delivery` → **collectAddress** → **payment**
8. **payment** — `chargeCopay` with `needsApproval: true` (durable `__approval` pause before charge)
9. **finalReply** — confirmation + interaction note + STOP line → `{ end: 'ordered' }`

**Escalation:** agent instructions: “speak to a pharmacist” → flow/handoff emits `targetAgent: 'human'`; `ownership` claims the thread (bot silent until release).

**Consent:** `sessionConsentStore(..., { defaultOptedIn: false })`. After order, callers should `consent.optIn(customerId)`. `STOP` opts out; `consentGate` and broadcasts skip un-opted-in customers.

**Refill reminder:** `sendRefillReminder` uses the same strategist as outbound policies. Closed WhatsApp window → APPROVED template `refill_reminder` (param `1` = medication). Open window → free-form text. `broadcasts.send` is idempotent per campaign+customer.

## Copay approval

`chargeCopay` is registered with `needsApproval: true`. The first `ctx.tool('chargeCopay', …)` in **payment** suspends on signal `__approval` until a human (or test harness) delivers `{ approved: true }`. Denied approval throws `ToolApprovalDeniedError` and never runs the charge effect. See `packages/kuralle-core/test/core-policy/needs-approval.test.ts` for the core contract; this example wires the tool on the agent’s `tools` map.

## Run (live model, fake Meta clients)

```bash
bun run packages/kuralle-engagement/examples/pharmacy/run.ts
```

Without an API key, prints `SKIP: no live key` and exits 0.

## Tests (offline)

```bash
bun test packages/kuralle-engagement/examples/pharmacy/pharmacy.test.ts
```

| Test | What it proves |
|------|----------------|
| `verify_identity_extracts_name_dob` | `collect` submit tool → `fullName` / `dob` in state |
| `rx_choice_routes_by_id` | `rx-lis` id → `rxLabel`, routes to `interactionCheck` |
| `fulfilment_delivery_collects_address` | `delivery` → `collectAddress` |
| `refill_reminder_converts_to_template_on_closed_window` | closed window + opted in → `refill_reminder` template |
| `not_opted_in_blocks_refill_reminder` | broadcast skips default opted-out customer |
| `stop_halts_reminders` | STOP opts out; second broadcast skipped |
| `escalate_to_pharmacist_claims_ownership` | handoff → human owner; further inbound suppressed |

Extraction uses a **deterministic driver** (submit tool results), not a live model.

## Env

| Variable | Purpose |
|----------|---------|
| `OPENAI_API_KEY` | Live model |
| `GOOGLE_GENERATIVE_AI_API_KEY` | Live model |
| `XAI_API_KEY` | Live model |

No WhatsApp / Meta tokens required.
