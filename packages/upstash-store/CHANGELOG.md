# Changelog

All `@kuralle-agents/*` packages version in lockstep, so this file records the
release, not only this package. Full history: https://github.com/kuralle/kuralle-agents

## 0.23.2

Packaging only — no runtime change.

- `CHANGELOG.md` now ships in every published package. Until now the changeset config set
  `changelog: false` and no package listed a changelog in `files`, so a release carried no notes to
  anyone who installed it. 0.23.1 in particular changed a peer requirement with nothing to read.

## 0.23.1

**Requires `ai@^7`.** Every `@kuralle-agents/*` package moves from the AI SDK v6 peer range to
`^7.0.0`. This shipped as a patch, so `^0.23.0` picks it up automatically: a pinned `ai@6` fails peer
resolution, and an unpinned `ai` moves to v7 silently. Upgrade `ai` alongside it.

### Breaking

- **`CompactionResult`** — `compactMessages` no longer embeds the compaction summary in `messages`.
  Read `result.summary` instead. `afterTokens` now counts only the retained tail, excluding the
  summary's tokens.

### AI SDK 7

- Declared `ai` ranges widened to `^7.0.0` across every published package, and the floating
  `"ai": "latest"` in playground templates replaced with an explicit range.
- The model turn loop reads v7's `stream`, `usage` and `finalStep.response` in place of the
  deprecated `fullStream`, `totalUsage` and `response`.
- Telemetry moved to `@ai-sdk/otel`. Registration is **opt-in** via `HarnessConfig.aiSdkTelemetry`:
  v7 traces by default once an integration is registered, so adopting v7 does not silently start
  emitting spans for an existing deployment.
- Tool order is pinned with v7's `ToolOrder`, derived by sorting the merged tool set. Measured live:
  a shuffled tool order without it drops the prompt-cache read rate from 74.5% to 49.6%.

### MCP

- **Tool-drift guard.** Each listing is fingerprinted (`description`, `inputSchema`, `title`) and
  compared per tool against a trust baseline stored in a new `toolFingerprints` column. A **changed**
  tool is quarantined — it keeps its name so the model can explain the gap, but its description is
  replaced, its schema emptied, and calling it refused. An **added** tool is withheld; a **removed**
  one is logged. The server is never refused wholesale.
- `retrustMcpServer(store, serverName)` clears a baseline when a change was legitimate. `save()`
  cannot replace one, by design.
- **Session lifecycle.** `close()` now sends the `DELETE` that terminates a Streamable HTTP session,
  and an expired session (HTTP 404) reconnects and retries once instead of leaving the client stuck
  on a stale session id.

### Other

- `toolDeniedResult`, `toolErrorResult` and `InvalidCallerMessagesError` are exported from core.
- Caller-supplied message arrays containing `role: 'system'` are rejected before any session is
  written, and surface as HTTP 400 rather than 500.
- `turn`-lifetime system notes are now consumed at the turn boundary; previously they behaved
  identically to `run` lifetime and leaked into every later turn.

