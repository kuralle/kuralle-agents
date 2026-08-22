---
"@kuralle-agents/core": patch
---

**Breaking:** `CompactionResult` from `compactMessages` no longer embeds the compaction summary in `messages`.

- **Field move:** When `compacted: true`, the summary text moved from `messages[0]` to a new `summary: string` field; `messages` is the verbatim retained tail only.
- **`afterTokens` semantics:** `afterTokens` now counts tokens in the retained tail only and excludes the summary.

**Migration:** Read `result.summary` (and pass it to your system-note channel) instead of `result.messages[0]`; do not assume `afterTokens` includes summary tokens.
