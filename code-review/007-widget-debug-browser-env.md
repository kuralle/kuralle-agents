# 007 — Widget `KURALLE_DEBUG` gate ineffective in browser bundles

| Field | Value |
|-------|-------|
| **Severity** | low |
| **Axis** | correctness / DX |
| **Status** | open |
| **Location** | `packages/kuralle-widget/src/debug.ts:1-2` |

## What's wrong

Widget debug uses a `globalThis.process?.env` shim:

```typescript
const proc = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process;
const ENABLED = Boolean(proc?.env?.KURALLE_DEBUG);
```

In a Vite/browser bundle, `process.env.KURALLE_DEBUG` is typically undefined unless injected at build time. Node packages use `typeof process !== 'undefined' && process.env?.KURALLE_DEBUG` which works in Node/Bun.

## Why it matters

Consumers enabling debug for `@kuralle-agents/widget` in the browser may see **no traces** even with `KURALLE_DEBUG=1` at build time unless the app bundler defines the env var (e.g. Vite `define`).

## Evidence

- `packages/kuralle-widget/src/debug.ts` — globalThis shim, no `import.meta.env`
- Other packages use Node `process.env` pattern (`packages/kuralle-core/src/debug.ts`)

## Recommendation

For widget only: prefer `import.meta.env?.KURALLE_DEBUG` (Vite) with fallback to the Node check, or document that widget debug requires bundler injection. Not fixed — product decision on browser debug surface.
