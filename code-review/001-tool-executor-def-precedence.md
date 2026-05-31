# 001 — ToolExecutor prefers registry over explicit flow-local `def`

| Field | Value |
|-------|-------|
| **Severity** | high |
| **Axis** | correctness |
| **Status** | fixed |
| **Location** | `packages/kuralle-core/src/tools/effect/ToolExecutor.ts:86` |

## What's wrong

`executeInner` resolved the tool definition as:

```typescript
const def = this.tools.get(name) ?? args.def;
```

The JSDoc on `CoreExecuteArgs.def` claimed the explicit def takes preference over the registry — the opposite of the code.

## Why it fails

Flow-local tools are recovered in `resolveReplyNode` → `localTools` and passed to the executor via `ctx.tool(..., { def: localTool, toolCtx })`. The same tool name may also exist in `CoreToolExecutor`'s registry (from `agent.effectTools` or driver `toolDefs`).

When both exist with **different** `execute`/`input`/`interim` definitions, the registry copy ran while the driver supplied a rich `toolCtx` for the local copy. Validation, interim timing, and execution could diverge from the node-scoped tool the flow author defined — silently.

## Evidence

- `nodeBuilders.ts:44` — `localTools: rawToolsFromSet(tools)` always populates local tools for reply nodes.
- G5/G6 conformance tests (`conformance.test.ts:156–168`) register `slow`/`create_ticket` in **both** executor registry and `localTools` (same object today, but not guaranteed for all callers).
- Pre-fix architecture note in `implementation-notes.md` D7: local bypass was the root cause of G5/G6.

## Fix applied

```typescript
const def = args.def ?? this.tools.get(name);
```

JSDoc corrected to state explicit `def` wins. Rebuilt `@kuralle-agents/core`; 362/362 unit tests pass.
