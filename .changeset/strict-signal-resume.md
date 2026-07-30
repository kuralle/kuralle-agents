---
"@kuralle-agents/core": patch
"@kuralle-agents/cf-agent": patch
---

Reject signal-only turns that do not exactly match the session's pending interrupt, including approvals delivered to the wrong shopper session. Keep duplicate signal IDs idempotent while preventing absent or mismatched requests from entering the model loop.
