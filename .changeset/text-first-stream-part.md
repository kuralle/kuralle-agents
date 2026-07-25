---
"@kuralle-agents/core": major
"@kuralle-agents/hono-server": major
"@kuralle-agents/cf-agent": major
"@kuralle-agents/messaging": major
"@kuralle-agents/engagement": major
---

**Breaking:** rename `HarnessStreamPart` to `StreamPart` and replace the flat event union with a single `{ channel, type, payload }` envelope. Consumers must read variant data from `payload`; client filtering now follows the exhaustive `PART_CHANNEL` classification exported by core.
