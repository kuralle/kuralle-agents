---
"@kuralle-agents/hono-server": minor
"@kuralle-agents/widget": minor
---

**Breaking:** WebSocket stream messages now use the canonical `{ channel, type, payload }` `StreamPart` envelope. The widget consumes only client-channel stream parts, while `connected`, `cancelled`, and `pong` remain explicit transport frames. The unsupported welcome-suggestions wire feature and widget suggestion callbacks were removed.
