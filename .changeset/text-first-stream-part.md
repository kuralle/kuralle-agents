---
"@kuralle-agents/core": minor
"@kuralle-agents/hono-server": minor
"@kuralle-agents/cf-agent": minor
"@kuralle-agents/messaging": minor
"@kuralle-agents/engagement": minor
---

**Breaking:** rename `HarnessStreamPart` to `StreamPart` and replace the flat event union with a single `{ channel, type, payload }` envelope. Consumers must read variant data from `payload`; client filtering now follows the exhaustive `PART_CHANNEL` classification exported by core.
