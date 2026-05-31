# 010 — Dead export / dep prune (session cleanup verified)

| Field | Value |
|-------|-------|
| **Severity** | info (positive) |
| **Axis** | maintainability / breaking-change hygiene |
| **Status** | wontfix-with-reason (no change needed) |
| **Location** | 20 deleted exports, 18 removed deps, `knip.json` |

## Summary

Skeptical pass on the dead-code/deps work found **no false deletions** reachable via imports, dynamic requires in removed paths, or published API breakage.

## Evidence

1. **Deleted symbols** — grep for all 20 removed exports (`toNullableSchema`, `renderNodePrompt`, `sanitizeFlowControlSignal`, `ContextOverflowUnrecoverableError`, etc.) returns hits **only** in `implementation-notes.md`, not in source.
2. **Demoted internals** — `makeCtx`, `EffectClock` demoted in `ctx.ts`; no external imports (`grep makeCtx` → only `ctx.ts`).
3. **Removed barrels** — `flow/index.ts`, `metrics/index.ts` deleted; zero imports of those paths (`grep flow/index`, `metrics/index` → none).
4. **Removed `@cloudflare/workers-types`** from cf-agent/twilio packages — `typecheck:all` green; examples declare their own copy in workspace example package.json files.
5. **Build emit** — author ran `build:packages` for TS4023 private-name check; re-verified green after review.
6. **knip** — framework report 0 unused deps/unlisted/unused-files with authored config.

## Intentional leftovers (not bugs)

- Unwired `openai-family` subtree (29 symbols) — documented in D4, separate wire-or-remove track.
- Playground dynamic-runtime deps kept + `ignoreDependencies` — verified by grep (CLAUDE.md gotcha).
