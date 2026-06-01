# S6-02 — Q7 Instagram verification (vs current Meta docs, 2026-06)

**Verdict: VERIFIED — no divergence from the RFC assumptions. G2 may proceed. No `/grill-me` flag.**

Manager-run research gate (RFC §8 G/S6-02, Q7). Sources: Meta Instagram Platform / Messenger Platform developer docs (`developers.facebook.com`), accessed 2026-06.

| RFC assumption (§4.12 IG row / Q7) | Meta docs (verified) | Result |
|---|---|---|
| 24h standard messaging window | 24-hour standard messaging window for free-form messages | ✅ matches |
| Closed-window recovery via `HUMAN_AGENT` message tag | `human_agent` tag permits a human-agent response within **7 days** of the user's last message | ✅ valid (duration = 7 days, more generous than a 24h window) |
| Quick replies ≤13 | **Maximum 13** quick-reply buttons; title **plain text ≤20 chars** (truncated if longer) | ✅ matches (enforce the 20-char title cap in the renderer) |
| Carousel via generic template | Generic template = horizontally-scrollable carousel, **max 10 elements** | ✅ matches |
| Button template ≤3 buttons | Button template sends text with **up to 3** attached buttons | ✅ matches |
| No template-approval system → limited proactive re-engagement | IG messaging has no pre-approved-template system (unlike WhatsApp) | ✅ matches |
| Tag wraps **text only**; interactive/media outside window **defer** (IG-CW) | `human_agent` tag is a message tag on a standard message send (text response); not a path for templated/interactive sends outside the window | ✅ conservative-correct (defer interactive/media) |

**Enrichments for the G2 brief (S6-03):**
1. `HUMAN_AGENT` tag duration is **7 days** (document in the IG policy; the RFC §4.12 didn't state it).
2. Quick-reply title cap is **20 chars** — the IG renderer must reject/validate over-length titles (no silent truncation, mirroring R-11), consistent with the WhatsApp renderer.

**RFC impact:** Q7 is resolved as **confirmed**; the `instagramPolicy` design in §4.12 stands. The RFC `05-security-rollback-open-qs.md` Q7 entry is amended to "RESOLVED (verified 2026-06)" in the same change.

Sources:
- https://developers.facebook.com/docs/features-reference/human-agent (HUMAN_AGENT tag, 7-day window)
- https://developers.facebook.com/docs/instagram-platform/instagram-api-with-instagram-login/messaging-api/quick-replies/ (max 13 quick replies, 20-char titles)
- https://developers.facebook.com/docs/messenger-platform/instagram/features/generic-template (carousel max 10 elements)
- https://developers.facebook.com/docs/messenger-platform/send-messages/template/button (button template ≤3 buttons)
