# Inbound message coalescing ("buffered text-ins") — research + design (2026-06-10)

Problem: WhatsApp users send bursts ("hi" / "i want to order" / "the blue one"); kuralle
today serializes them into N turns with N answers (per-session mutex = Rasa-style ticket
lock — ordered, never merged).

## Industry survey (full citations in the 2026-06-10 research run)

| System | Mechanism | Window | Merge | Mid-turn |
|---|---|---|---|---|
| openclaw (Baileys gateway) | sliding debounce per chat | default off; 5s example | newline join | reply-queue `steer` |
| Evolution API | `debounceTime` | **10s default** | one input | gateway-level |
| BuilderBot | debounce + accumulator | **1.5s** | array, one response | queue (concurrency 15) |
| Chatwoot (proposal #13697) | wait-and-batch | 1–3s proposed | one event | — |
| n8n Redis pattern | sliding `last_ts`, cancel superseded | 10s | newline join | last-message-wins (pre-send only) |
| Twilio Studio | same-execution routing (structural) | — | feeds waiting widget | new msg → active execution |
| LangGraph | double-texting taxonomy | — | — | reject/enqueue/interrupt/rollback |
| Voice (Vapi/Retell/LiveKit) | endpointing min/max + turn-detector model | 0.2–0.5s min, 6s max | transcript accumulation | barge-in |
| Rasa / Botpress / Intercom / Tidio | none (reply per message) | — | — | FIFO lock |

Key takeaways: (1) sliding/trailing debounce keyed by thread is THE pattern in
WhatsApp-centric stacks, 1.5–10s band; (2) a max-wait cap is what the voice domain gets
right and naive text debouncers miss; (3) mid-turn policy: enqueue/steer — never
cancel-and-restart on channels where partial replies are already delivered; (4) WhatsApp
Cloud API has NO inbound typing signal (outbound typing indicator only) — timer-based is
the only primary mechanism available; (5) default-off outside messaging channels (web
chat with a submit box doesn't fragment).

## Kuralle design (implemented as WS-A4)

Two layers:
1. **Ingress coalescer** (`@kuralle-agents/messaging`): per-thread sliding debounce —
   `debounceMs` 3000 default (0=off), `maxWaitMs` 10000 cap, `maxMessages` 10,
   immediate-flush for interactive selections. Merge = one `UserContent` parts array in
   arrival order (image-then-caption burst → `[FilePart, TextPart]`, one turn). Router
   option `inboundCoalescing`; default off.
2. **Drain-and-merge at turn admission** (`@kuralle-agents/core`):
   `consumeAllPendingUserInput` — everything queued mid-turn becomes ONE merged next
   turn (Twilio same-execution / LangGraph enqueue semantics), not N serialized answers.

Mid-turn policy: `enqueue-merge`; interrupt/steer reserved as v2 (out-of-band control
evaluator is the seam). DO note: the DO is the thread, timers live with the
conversation; `storage.setAlarm` is the eviction-proof upgrade path. v2 upgrade:
completeness detection (no terminal punctuation / trailing connective → extend wait),
the text analog of LiveKit's turn-detector — adjusts the sliding timer, never the cap.
While buffering, send the (2025) WhatsApp typing indicator for perceived attentiveness.
