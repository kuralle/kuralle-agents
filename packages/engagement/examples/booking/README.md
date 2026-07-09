# Booking example — reservations bot

Deep example for `@kuralle-agents/engagement`: **free-form extraction** (`collect`), **interactive choices routed by stable id** (`withChoices` + `decide`), and a **closed-window hold reminder** converted to an APPROVED WhatsApp template.

## Flow (`acme-bookings` / `reservations`)

1. **greet** — welcome, ask what to book  
2. **collectDetails** — extract `partySize`, `date`, optional `time` / `name`  
3. **checkAvailability** — mock tool returns `18:30`, `19:00`, `20:15`  
4. **pickSlot** — buttons/list by slot id  
5. **confirm** — `yes` → book, `no` → collect again  
6. **book** — mock `createReservation` → confirmation code  
7. **finalReply** — confirm code + time → `{ end: 'booked' }`

**Hold reminder:** `sendHoldReminder(threadId, platform, state)` uses the same strategist as outbound policies. On a **closed** WhatsApp window, free-form reminder text becomes template `booking_hold` (params `1`=date, `2`=partySize). On an **open** window it sends as normal text.

## Run (live model, fake Meta clients)

```bash
# From repo root — needs OPENAI_API_KEY, GOOGLE_GENERATIVE_AI_API_KEY, or XAI_API_KEY
bun run packages/engagement/examples/booking/run.ts
```

Without a key, prints `SKIP: no live key` and exits 0.

## Tests (offline)

```bash
bun test packages/engagement/examples/booking/booking.test.ts
```

| Test | What it proves |
|------|----------------|
| `extracts_booking_details_into_state` | `collect` submit tool → `partySize` / `date` / `time` in flow state |
| `slot_choice_routes_by_id` | `selection.id = '19:00'` → `confirmedTime`, routes to `confirm` (label-independent) |
| `closed_window_hold_reminder_converts_to_template` | closed window → `booking_hold` template, no `sendText` |
| `open_window_sends_freeform` | open window → `sendText`, no template |

Extraction in tests uses a **deterministic driver** (submit tool results), not a live model. Live extraction is exercised only in `run.ts` when an API key is present.

## Sample transcript (deterministic test run)

```
extracts_booking_details_into_state  → state: partySize=4, date=2026-06-12, time=19:00
slot_choice_routes_by_id             → confirmedTime=19:00, activeNode=confirm
closed_window_hold_reminder…         → sendTemplate(booking_hold), sendTextCalls=0
open_window_sends_freeform           → sendTextCalls=1, sendTemplateCalls=0
```

## Env

| Variable | Purpose |
|----------|---------|
| `OPENAI_API_KEY` | Live model (preferred if set alone) |
| `GOOGLE_GENERATIVE_AI_API_KEY` | Live model |
| `XAI_API_KEY` | Live model |

No WhatsApp / Meta tokens required — platforms are in-memory fakes that record outbound sends.
