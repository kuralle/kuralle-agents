# RFC: Tool model cleanup — one durable tool concept

**Category:** Architectural Change (breaking, pre-1.0)
**Author:** kuralle-harness program
**Date:** 2026-06-07
**Status:** Draft
**Reviewers:** (program)
**Related:** `research/tools-vs-effecttools-analysis.md`, `research/BLUEPRINT-whats-next.md`, `docs/adr/0001-agent-base-layer-in-every-node.md`, `rfcs/kuralle-harness/README.md`

---

## 1. Problem Statement

`AgentConfig` exposes three tool-ish fields — `tools?: ToolSet`, `effectTools?: Record<string,AnyTool>`, `globalTools?: Record<string,AnyTool>` (`packages/kuralle-core/src/types/agentConfig.ts:26-33`) — but there are only **two concepts**, and one field is a correctness footgun.

- `effectTools` and `globalTools` are the *same* durable primitive (`defineTool`); both are registered into the one `CoreToolExecutor` (`runtime/Runtime.ts:118-125`). They differ only by visibility/safety policy.
- The raw `tools?: ToolSet` field carries its own `execute`, which the AI SDK auto-runs inside `streamText` (`runtime/channels/TextDriver.ts:65-75`), **bypassing the durable exactly-once journal** (`runtime/ctx.ts:97-131,208-209`). It is never registered in the executor, so if a call were ever routed there it throws `Unknown tool` (`tools/effect/ToolExecutor.ts:89-91`). It is wired only on the off-flow host reply node (`runtime/agentReply.ts:14`).

Success: one durable tool concept (`tools` = effect tools, always journaled) + `globalTools` (visibility policy); the non-durable raw path is removed; third-party AI SDK tools enter only through an adapter that routes them through the journal; a CI guard makes "raw `execute` reaches `streamText`" impossible; the durable journal keying is verified Workers-portable.

## 2. Background

The durability mechanism is real and net-new vs the AI SDK / OpenAI Agents SDK (both defer durability to an external orchestrator like Temporal — `research/tools-vs-effecttools-analysis.md` §3). `defineTool` → `buildToolSet` strips `execute` via `toolToAiSdk` (`tools/effect/defineTool.ts:49-63`) so the model sees a schema-only tool; execution runs through `ctx.tool` → `replayOrExecute` (`runtime/ctx.ts:208-209`), keyed by `toolEffectKey` (sha256 of runId+callsite+name+args, `runtime/durable/idempotency.ts:17-24`), giving exactly-once-on-replay. Replay fires on durable resume: voice turns, Cloudflare DO rehydration, crash recovery.

The split is therefore the Temporal "activities vs workflow" pattern (`effectTools` = activities; the flow/agent loop = the deterministic workflow). The accident is the *third* field: raw `tools?: ToolSet` predates the AI-SDK-native migration (0.5.0) and is the one path where a side effect runs un-journaled.

Blast radius of the rename (measured `2026-06-07`): `effectTools` appears in **59 in-repo files** — 4 core src (`agentConfig.ts`, `runtime/Runtime.ts`, `tools/effect/defineTool.ts`, `flow/nodeBuilders.ts`), 2 tests, and ~53 examples/docs/playground/guides. All in-repo → a mechanical codemod is safe. `node:crypto` is imported in 10 core files including the journal (`ctx.ts:1`, `idempotency.ts:1`); `@kuralle-agents/cf-agent` already ships on Workers at 0.5.0, so this is a **verify-and-add-fallback** task, not a confirmed break.

Runner-up considered and rejected: *unify-to-one* `tools` map with per-tool `{ visibility?: 'flow'|'global' }`, collapsing `globalTools`. Leaner surface but a costlier, riskier migration that also dissolves the ADR-0001 safety allow-list into a runtime assertion. Not worth it now.

## 3. Strict Requirements

- REQ-1: `AgentConfig.effectTools` is renamed to `AgentConfig.tools` (the durable `Record<string,AnyTool>` primitive). The old raw `tools?: ToolSet` field is removed.
- REQ-2: `AgentConfig.globalTools` is unchanged in meaning (ADR-0001 visibility/safety allow-list of durable tools).
- REQ-3: Third-party AI SDK tools (`ai` `Tool`/`ToolSet`) are usable only via a new `wrapAiSdkTool(name, aiTool)` adapter that produces an `AnyTool` whose `execute` is captured and run through the journal.
- REQ-4: No tool `execute` ever reaches `streamText`. Every tool the model can call is presented schema-only (`toolToAiSdk`) and executed by `CoreToolExecutor`, including the host reply node (`agentReply.ts`).
- REQ-5: A CI guard fails the build if any node passes a tool with `execute` still attached to `streamText`/the model.
- REQ-6: The durable journal keying (`createHash`, `randomUUID`) works on Cloudflare Workers — either via verified `nodejs_compat` or a WebCrypto fallback (`crypto.subtle.digest`, `crypto.randomUUID`). No regression to Node.
- REQ-7: No compat shim is left as permanent debt. No deprecated `effectTools` alias survives this change (full in-repo codemod instead).
- REQ-8: `bun run typecheck:all` and `bun run test` are green; all examples/docs/playground compile and the shipped examples run.

## 4. Interface Specification

### 4.1 `AgentConfig` (modified)
- **Location:** `packages/kuralle-core/src/types/agentConfig.ts`
- **Change:** remove `tools?: ToolSet`; rename `effectTools?: Record<string,AnyTool>` → `tools?: Record<string,AnyTool>`; keep `globalTools?: Record<string,AnyTool>`.
- **Behavior:** `tools` is the durable model-callable surface; `globalTools` is the always-visible safe subset. Both are journaled.
- **JSDoc:** state that `tools` are durable effect tools (exactly-once on replay); to use a raw AI SDK tool, wrap with `wrapAiSdkTool`.

### 4.2 `wrapAiSdkTool` (new)
- **Location:** `packages/kuralle-core/src/tools/effect/wrapAiSdkTool.ts`
- **Signature:** `wrapAiSdkTool(name: string, aiTool: import('ai').Tool): AnyTool`
- **Behavior:** returns an `AnyTool` (`{ name, description, input, execute }`) where `input` is the AI SDK tool's `inputSchema` and `execute(args, ctx)` invokes the AI SDK tool's `execute` — so it runs through `CoreToolExecutor`/the journal like any `defineTool`.
- **Error cases:** throws at construction if `aiTool` has no `execute` (a schema-only AI SDK tool has nothing to run durably — caller should `defineTool` instead).

### 4.3 `buildAgentReplyNode` (modified)
- **Location:** `packages/kuralle-core/src/runtime/agentReply.ts:3-19`
- **Change:** `tools: agent.tools` (raw ToolSet) → build the node's model-visible set with `buildToolSet(agent.tools)` (schema-only) and ensure the executors are registered (they already are via `Runtime.ts:118-125` merge of `agent.tools`). Host-reply tool calls then flow `executeModelTool` → `ctx.tool` → `replayOrExecute`.

### 4.4 Runtime executor merge (modified)
- **Location:** `packages/kuralle-core/src/runtime/Runtime.ts:118-125`
- **Change:** `effectTools` local renamed to reflect new field; merge becomes `{ ...config.tools, ...agent.tools, ...agent.globalTools }`. Semantics unchanged (still the executor registry).

### 4.5 Workers crypto seam (verify/modify)
- **Location:** `packages/kuralle-core/src/runtime/durable/idempotency.ts`, `runtime/ctx.ts`
- **Signature (if fallback needed):** `sha256Hex(material: string): Promise<string>` and `uuid(): string` resolving to WebCrypto on Workers, `node:crypto` on Node (runtime-detected, no `node:*` in the Workers bundle path).
- **Behavior:** identical key output across runtimes; `toolEffectKey` stays deterministic.

## 5. Architecture and System Dependencies

### 5.1 Structural changes
Modify `agentConfig.ts`, `Runtime.ts`, `agentReply.ts`, `defineTool.ts` (export `wrapAiSdkTool`), add `wrapAiSdkTool.ts`. Codemod 53 example/doc/playground files. Possibly add `idempotency`/`ctx` crypto fallback. Add `scripts/check-no-raw-tool-execute.sh`.

### 5.2 Service/library dependencies
None added. `ai` package still the model SDK; `wrapAiSdkTool` is the only interop seam.

### 5.3 Data/schema changes
None. The effect-log/step format (`runtime/durable/*`) is unchanged.

### 5.4 Network/performance
No new calls. WebCrypto `subtle.digest` is async; if introduced, `toolEffectKey` callers must `await` — confirm `replayOrExecute` is already async (it is, `ctx.ts:97`).

## 6. Pseudocode

```
# AgentConfig
- remove field tools: ToolSet
- rename field effectTools -> tools  (Record<string, AnyTool>)

# wrapAiSdkTool(name, aiTool)
IF aiTool.execute is missing: THROW "wrap a schema-only AI SDK tool? use defineTool"
RETURN { name, description: aiTool.description, input: aiTool.inputSchema,
         execute: (args, ctx) => aiTool.execute(args, ctx) }

# agentReply node
node.tools = buildToolSet(agent.tools)   # schema-only; executors already registered in Runtime

# Runtime executor registry (unchanged semantics)
registry = { ...config.tools, ...agent.tools, ...agent.globalTools }

# CI guard (check-no-raw-tool-execute.sh)
grep for streamText({... tools: X ...}); assert X is produced by buildToolSet/resolveTools
  (which strip execute). Fail if any model-facing tool object literal has an `execute` key.

# crypto seam (only if nodejs_compat insufficient)
toolEffectKey(...) = sha256Hex(material)   # WebCrypto on workers, node:crypto on node
```

## 7. Code Blueprint

```ts
// packages/kuralle-core/src/tools/effect/wrapAiSdkTool.ts
import type { Tool as AiTool } from 'ai';
import type { AnyTool } from '../../types/effectTool.js';
import type { ToolContext } from '../../types/run-context.js';

export function wrapAiSdkTool(name: string, aiTool: AiTool): AnyTool {
  const exec = (aiTool as { execute?: (a: unknown, c?: unknown) => unknown }).execute;
  if (typeof exec !== 'function') {
    throw new Error(`wrapAiSdkTool("${name}"): AI SDK tool has no execute; use defineTool for schema-only tools.`);
  }
  return {
    name,
    description: aiTool.description ?? name,
    input: (aiTool as { inputSchema?: AnyTool['input'] }).inputSchema,
    execute: (args, ctx?: ToolContext) => exec(args, ctx) as Promise<unknown>,
  } as AnyTool;
}
```

```ts
// packages/kuralle-core/src/runtime/agentReply.ts  (modified)
import { buildToolSet } from '../tools/effect/defineTool.js';
// ...
return {
  kind: 'reply',
  id: `${agent.id}__host`,
  instructions,
  tools: agent.tools ? buildToolSet(agent.tools) : undefined, // schema-only; executors registered in Runtime
  model: agent.model,
};
```

```ts
// agentConfig.ts (modified shape)
export interface AgentConfig {
  // ...
  /** Durable, model-callable effect tools (exactly-once on replay). Wrap raw AI SDK tools with wrapAiSdkTool(). */
  tools?: Record<string, AnyTool>;
  /** ADR-0001 always-visible safe allow-list; a subset of the durable tools. */
  globalTools?: Record<string, AnyTool>;
  // (no raw `tools?: ToolSet`)
}
```

Codemod sketch (chunk C5):
```bash
# rename field key in object literals across examples/docs/playground
rg -l 'effectTools\s*:' --glob '!packages/kuralle-core/src/**' \
  | xargs sed -i '' 's/\beffectTools\s*:/tools:/g'
# then hand-review any agent that ALSO had a raw `tools:` ToolSet (now a collision) and wrap with wrapAiSdkTool
```

## 8. Incremental Task Breakdown

| ID | Chunk | Files | Grounding | Acceptance criteria |
|----|-------|-------|-----------|---------------------|
| C1 | Add `wrapAiSdkTool` + export from `tools/effect/index.ts` and core `index.ts` | `tools/effect/wrapAiSdkTool.ts`, `tools/effect/index.ts`, `src/index.ts` | REQ-3, `test:wrap-ai-sdk-tool` | new unit test: wrapped tool executes via executor and is journaled; throws on schema-only input |
| C2 | Rename field `effectTools→tools`, remove raw `tools?: ToolSet`; update `Runtime.ts` merge + JSDoc | `types/agentConfig.ts`, `runtime/Runtime.ts` | REQ-1,REQ-2 | typechecks; executor registry merges `agent.tools` |
| C3 | Journal-route host reply node | `runtime/agentReply.ts` | REQ-4, `test:agentreply-journaled` | host-reply tool call goes through `ctx.tool`; no `execute` on the node's model tools |
| C4 | CI guard script | `scripts/check-no-raw-tool-execute.sh`, wire into `typecheck:all`/CI | REQ-5, `cmd:guard` | guard fails on a planted raw-execute tool, passes on HEAD |
| C5 | Codemod examples/docs/playground/guides/tests (`effectTools:`→`tools:`; wrap raw ToolSets) | ~53 files (see §2) | REQ-7,REQ-8 | `bun run typecheck:all` green; shipped examples run |
| C6 | Verify/patch Workers crypto for journal keying | `runtime/durable/idempotency.ts`, `runtime/ctx.ts`, cf-agent build config | REQ-6, `test:journal-key-workers` | journal key identical Node vs Workers (vitest-pool-workers); no `node:*` in Workers bundle path |
| C7 | Docs + CHANGELOG + MIGRATION note (`effectTools`→`tools`, raw ToolSet → `wrapAiSdkTool`) | `MIGRATION.md`, `CHANGELOG.md`, `packages/kuralle-core/guides/TOOLS.md`, `docs/skills/kuralle-usage/*` | REQ-8 | docs reference only `tools`/`globalTools`; migration steps runnable |

## 9. Validation and Testing

### 9.0 Validation contract
| ID | Source | Assertion |
|----|--------|-----------|
| REQ-1..8 | §3 | as stated |
| test:wrap-ai-sdk-tool | §9.1 | wrapped AI SDK tool runs through `CoreToolExecutor` and is recorded in the step log |
| test:agentreply-journaled | §9.1 | a host-reply (off-flow) tool call is replayed exactly-once on a simulated resume |
| test:journal-key-workers | §9.1 | `toolEffectKey` output is byte-identical on Node and in a Workers test env |
| cmd:guard | §9.3 | `scripts/check-no-raw-tool-execute.sh` exits non-zero on planted violation, zero on HEAD |
| cmd:gate | §9.3 | `bun run typecheck:all && bun run test` green |

### 9.1 Fail-to-pass tests
- `test:wrap-ai-sdk-tool` — assert a `wrapAiSdkTool` tool produces a step-log entry (journaled), and that a second invocation with the same args/callsite replays the recorded result.
- `test:agentreply-journaled` — drive the host reply node with a tool; simulate resume; assert the tool executor ran once.
- `test:journal-key-workers` — run `toolEffectKey` under vitest-pool-workers and Node; assert equality.

### 9.2 Regression (pass-to-pass)
- `packages/kuralle-core/test/**` (esp. `core-agent/global-tools.test.ts`, `core-policy/approval.smoke.ts`), `kuralle-e2e-tests`.

### 9.3 Validation commands
```bash
bun run build && bun run typecheck:all && bun run test
bash scripts/check-no-raw-tool-execute.sh            # expect exit 0 on HEAD
# live smoke (Node): run a shipped effect-tool example end-to-end
bun packages/kuralle-core/examples/agents/echo.ts
```

## 10. Security Considerations
No new attack surface. Net positive: removing the un-journaled path closes a double-execution hazard for mutating tools (exactly the class ADR-0001/`globalTools` guards). `wrapAiSdkTool` does not widen capability — wrapped tools are subject to the same enforcer/approval gates.

## 11. Rollback and Abort Criteria
- Abort if: after C6, the journal key cannot be made identical across Node and Workers without pulling `node:*` into the Workers bundle — escalate (the durability contract is at stake), do not ship a Workers-only divergent key.
- Abort if: removing raw `tools?: ToolSet` breaks a flow path other than `agentReply` that the codemod did not surface — re-scope, do not silently re-add the field.
- Rollback: revert the field rename commit; `wrapAiSdkTool` and the CI guard are additive and can stay.

## 12. Open Questions
- Q1: Keep a one-release deprecated `effectTools` alias for external consumers? — tradeoff: smoother external migration vs guiding-light #4 (no shims). **Proposal:** No alias. Full in-repo codemod; document the rename in `MIGRATION.md`. Breaking is acceptable pre-1.0.
- Q2: Is `nodejs_compat` already sufficient for the journal on cf-agent (making C6 a no-op verification)? — tradeoff: skip work vs latent Workers break. **Proposal:** Treat C6 as verify-first; only add the WebCrypto fallback if the vitest-pool-workers test fails. Either way the test (`test:journal-key-workers`) is the gate.
- Q3: Should `globalTools` collapse into `tools` with a `visibility` flag (the unify-to-one option)? — tradeoff: one field vs ADR-0001 safety allow-list clarity + migration cost. **Proposal:** No. Keep `globalTools` as the explicit safety surface; revisit at 1.0.
