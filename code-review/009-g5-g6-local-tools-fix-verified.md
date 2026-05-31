# 009 — G5/G6 flow-local tool routing (session fix verified)

| Field | Value |
|-------|-------|
| **Severity** | info (positive) |
| **Axis** | correctness / architecture |
| **Status** | wontfix-with-reason (no change needed) |
| **Location** | `TextDriver.ts`, `VoiceDriver.ts`, `ctx.ts`, `ToolExecutor.ts` |

## Summary

The session's highest-risk change — routing flow-local tools through `ctx.tool` / `CoreToolExecutor` instead of direct `localTool.execute()` — is **architecturally correct** and verified.

## Evidence

1. **Root cause confirmed** — `resolveReplyNode` sets `localTools: rawToolsFromSet(tools)` (`nodeBuilders.ts:44`). Pre-fix drivers bypassed executor for any matching `localTools` entry.
2. **Durable replay** — `ctx.tool` wraps `replayOrExecute(toolEffectKey(...))` (`ctx.ts:184-197`). Local tools now participate in effect log replay like registry tools.
3. **Driver parity** — TextDriver and VoiceDriver use identical spread-conditional for `def`/`toolCtx` (lines 95-107 vs 174-186).
4. **Tests** — `conformance.test.ts` G5 (interim) and G6 (`ToolValidationError` before backend) pass; full core suite **362 pass / 0 fail**.
5. **No double execution** — single `ctx.tool` call per tool-call event; ordinal consumed once via `consumeCallsite()`.

## Residual note

Finding **001** corrected registry-vs-`def` precedence when names collide. With 001 fixed, local tools are truly first-class.
