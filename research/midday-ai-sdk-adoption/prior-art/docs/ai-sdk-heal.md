# ai-sdk-heal — firsthand inspection

Inspected clone: `research/midday-ai-sdk-adoption/prior-art/clones/ai-sdk-heal`
Repo: `github.com/pontusab/ai-sdk-heal` (author Pontus Abrahamsson — Midday founder)
Version: `0.2.0` · last commit `3e56f80` dated **2026-06-03**.

## License (verified)

**MIT.** Confirmed two ways, both firsthand:
- Root `LICENSE` file present: `MIT License / Copyright (c) 2026 Pontus Abrahamsson` (full standard MIT text, no modifications).
- `package.json` → `"license": "MIT"`.

## What it is

A pure-function library that **repairs broken Vercel AI SDK `ModelMessage[]` arrays before they hit the provider**, fixing the structural states that make OpenAI/Anthropic/Google reject a request with a 400 (orphaned tool calls, invalid tool names, raw-string tool inputs, unsigned Anthropic reasoning, duplicate tool results, empty assistant messages, trailing OpenAI reasoning). It ships both an imperative API (`healMessages`) and an AI-SDK model middleware (`withHealing` / `healMiddleware`).

The README/changelog tie each rule to a specific tracked upstream `vercel/ai` issue (e.g. #9141 hallucinated XML tool names, #13645 raw-string tool input, #11602 unsigned reasoning, #13430 reasoning-only message, #8379 OpenAI trailing reasoning, #8516/#14259 tool pairing). These are referenced verbatim in the rule docstrings, so the project is positioning itself as a maintained workaround layer for live SDK bugs.

## AI-SDK-native? YES

It is built directly on the Vercel AI SDK, not a parallel abstraction:
- `package.json` declares `"peerDependencies": { "ai": ">=5.0" }`, marked **non-optional** (`peerDependenciesMeta.ai.optional: false`). Dev/test pin `ai@^6.0.195`.
- All source imports `type { ModelMessage }` (and `AssistantContent`, `ToolCallPart`, `ToolResultPart`, etc.) **from `"ai"`** — it operates on the SDK's canonical message type, not a custom shape.
- The middleware imports `wrapLanguageModel` from `"ai"` and the `LanguageModelV3*` types from `"@ai-sdk/provider"`, and implements a real `LanguageModelV3Middleware` (`specificationVersion: "v3"`, `transformParams`).
- Integration tests run healed output through the **real** `generateText` path against `MockLanguageModelV3` from `ai/test`.

## API surface (real signatures)

From `src/index.ts` (the public barrel) and the defining files:

```ts
// heal.ts
function healMessages(input: ModelMessage[], options?: HealOptions): HealResult
function inferProvider(model: unknown): Provider | undefined
class MessageHealingError extends Error { readonly repairs: Repair[] }

// middleware.ts
function withHealing(model: LanguageModelV3, options?: HealMiddlewareOptions): LanguageModelV3
function healMiddleware(options?: HealMiddlewareOptions): LanguageModelV3Middleware
interface HealMiddlewareOptions extends HealOptions {
  onHealed?: (e: { type: "generate" | "stream"; repairs: Repair[]; model: LanguageModelV3 }) => void
}

// validate.ts
function validateMessages(input: ModelMessage[], options?: HealOptions): ValidateResult
interface ValidateResult { valid: boolean; issues: Repair[] }

// rules/ (individual rules exported for custom pipelines)
const healInvalidToolName, healInvalidToolInput, healDuplicateToolResult,
      healToolPairing, healEmptyAssistantMessage: Rule           // shared
const healMissingReasoningSignature, healOrphanReasoningOnlyMessage: Rule  // anthropic
const healReasoningWithoutFollowingItem: Rule                    // openai
function rulesFor(provider: Provider | undefined): Rule[]
```

Key types (`src/types.ts`):

```ts
type Provider = "anthropic" | "openai" | "google" | "bedrock-anthropic"
interface HealOptions { provider?: Provider; policy?: Policy; throwOnRepair?: boolean; onRepair?: (r: Repair) => void }
interface HealResult { messages: ModelMessage[]; repairs: Repair[] }
interface Repair { rule: RuleName; messageIndex: number; partIndex?: number;
  action: "dropped-message"|"dropped-part"|"inserted-message"|"inserted-part"
         |"replaced-part"|"reordered-parts"|"renamed"|"coerced-input";
  reason: string; toolCallId?: string }
type Rule = (messages: ModelMessage[], ctx: RuleContext) => { messages: ModelMessage[]; repairs: Repair[] }
```

Per-issue `Policy` lets callers choose the repair strategy; `DEFAULT_POLICY` (the resolved defaults) is `orphanToolUse: "stub-result"`, `orphanToolResult: "drop"`, `invalidToolName: "rename"`, `invalidToolInput: "coerce-object"`, `emptyAssistantMessage: "drop"`, `duplicateToolResult: "dedupe-last"`, `orphanReasoningOnlyMessage: "drop-message"`, `missingReasoningSignature: "drop-reasoning"`, `reasoningWithoutFollowingItem: "drop-reasoning"`.

## Core mechanism

`healMessages` is a **fixed-order pipeline of pure, idempotent rule functions**. Each rule is `(messages, ctx) => { messages, repairs }`, returns a *new* array, and is required to be idempotent so the same call is safe on the hot path *and* offline against persisted DB rows. `healMessages` merges `options.policy` over `DEFAULT_POLICY`, picks the rule list via `rulesFor(provider)`, folds the array through each rule accumulating a `Repair[]` audit log, fires `onRepair` per repair (swallowing hook errors), and optionally throws `MessageHealingError` if `throwOnRepair`.

Rule order is load-bearing (`rules/index.ts`): `invalid-tool-name` → `invalid-tool-input` → `duplicate-tool-result` → `tool-pairing` → provider reasoning rules → `empty-assistant-message`. Names/inputs are normalized *before* pairing so call/result matching sees clean data; the empty-assistant cleanup runs last so it acts on the settled structure. Provider-specific rules are appended only for the matching provider — Anthropic/Bedrock get the two reasoning-signature rules, OpenAI gets the trailing-reasoning rule, Google gets none beyond shared. If `provider` is omitted, **only shared rules run** (provider-specific structural rules are skipped).

Notable per-rule behavior:
- **Orphan tool-use** (default `stub-result`): inserts a placeholder `tool-result` with `output: { type: "error-text", value: "...assume the operation failed or was interrupted." }` into the following tool message (creating one if absent), built bottom-up so insertion indices stay stable. Alternatives: `drop-call`, `keep`. Provider-executed calls (`providerExecuted`) are excluded from pairing.
- **Invalid tool name**: tests `^[a-zA-Z0-9_-]{1,64}$`; `rename` slugs both halves of the call/result pair (tracked by `toolCallId`) so they stay linked; `drop-pair` removes both.
- **Invalid tool input**: coerces non-object input — strings are JSON-parsed if possible else wrapped `{ raw: string }`, arrays → `{ values: [...] }`, scalars → `{ value: x }`.
- **Missing Anthropic reasoning signature**: drops unsigned reasoning parts; `hasAnthropicSignature` is forgiving — accepts the signature under either `providerOptions` **or** `providerMetadata`, and treats `redactedData` as also valid.
- **Empty assistant message**: drops only if not reasoning-only (reasoning-only is deferred to the Anthropic rule that knows whether the provider tolerates it).

### Middleware path and its documented limitation

`withHealing(model)` wraps the model once via `wrapLanguageModel`; `healMiddleware.transformParams` infers the provider from the model, runs a cheap structural `isHealablePrompt` guard (bails to a no-op pass-through if the SDK ever changes prompt shape), casts `LanguageModelV3Prompt ⇄ ModelMessage[]`, heals, and fires `onHealed` once per generate/stream call when repairs occurred.

Important scope caveat, stated in the changelog and confirmed by the code: the middleware heals provider-rejection issues (invalid names/inputs, unsigned reasoning, duplicates, trailing reasoning), but **orphan tool-use must still be fixed with `healMessages` upstream** because the SDK validates tool pairing during its *own* prompt conversion, before middleware `transformParams` sees it.

## Verbatim source snippets

`src/heal.ts:36-50` — the fold-over-rules pipeline with per-repair hook:
```ts
  for (const rule of rules) {
    const { messages: next, repairs } = rule(messages, ctx);
    messages = next;
    if (repairs.length === 0) continue;
    for (const r of repairs) {
      allRepairs.push(r);
      if (options.onRepair) {
        try {
          options.onRepair(r);
        } catch {
          // Never let an observability hook break healing.
        }
      }
    }
  }
```

`src/rules/index.ts:36-54` — fixed rule ordering + provider gating:
```ts
export function rulesFor(provider: Provider | undefined): Rule[] {
  const rules: Rule[] = [
    healInvalidToolName,
    healInvalidToolInput,
    healDuplicateToolResult,
    healToolPairing,
  ];

  if (provider === "anthropic" || provider === "bedrock-anthropic") {
    rules.push(healMissingReasoningSignature, healOrphanReasoningOnlyMessage);
  } else if (provider === "openai") {
    rules.push(healReasoningWithoutFollowingItem);
  } else if (provider === "google") {
    // Google tolerates reasoning blocks without signatures; no extra rules
```

`src/rules/shared.ts:447-456` — the orphan-tool-use stub result:
```ts
    const stubs: ToolResultPart[] = parts.map((p) => ({
      type: "tool-result",
      toolCallId: p.toolCallId,
      toolName: p.toolName,
      output: {
        type: "error-text",
        value:
          "Tool call was not completed and no result was recorded. Assume the operation failed or was interrupted.",
      },
    }));
```

`src/middleware.ts:51-65` — middleware infers provider and casts the SDK prompt to `ModelMessage[]`:
```ts
    transformParams: async ({ params, type, model }) => {
      const provider = healOptions.provider ?? inferProvider(model);

      // SAFETY: LanguageModelV3Prompt is a structural subset of
      // ModelMessage[] for the fields the rules care about ...
      if (!isHealablePrompt(params.prompt)) return params;

      const asMessages = params.prompt as unknown as ModelMessage[];
      const { messages, repairs }: HealResult = healMessages(asMessages, {
        ...healOptions,
        provider,
      });
```

`src/rules/anthropic.ts:77-87` — forgiving Anthropic signature detection (two carrier keys + redactedData):
```ts
  const carrier =
    (p as { providerOptions?: unknown; providerMetadata?: unknown })
      .providerOptions ??
    (p as { providerMetadata?: unknown }).providerMetadata;
  if (!carrier || typeof carrier !== "object") return false;
  const anthropic = (carrier as Record<string, unknown>).anthropic;
  if (!anthropic || typeof anthropic !== "object") return false;
  const signature = (anthropic as Record<string, unknown>).signature;
  if (typeof signature === "string" && signature.length > 0) return true;
  const redactedData = (anthropic as Record<string, unknown>).redactedData;
  return typeof redactedData === "string" && redactedData.length > 0;
```

## Maintenance signals

- **Version** `0.2.0` (CHANGELOG: 0.1.0 = pure healer; 0.2.0 added `withHealing`/`healMiddleware`/`validateMessages`).
- **Recency**: single git commit on the clone, `3e56f80` dated **2026-06-03** (`fix(tsconfig): silence baseUrl deprecation warning under TypeScript 6.0`) — very fresh, but shallow history (the clone shows only one commit).
- **Tests**: 4 test files (`heal`, `middleware`, `validate`, `integration`). After `bun install` I ran the suite firsthand: **55 tests pass, 0 fail, 111 expect() calls** (`bun test src/test`). The 2 earlier "failures" were solely a missing `ai/test` module pre-install, not code defects. Integration tests exercise the real `generateText` + `MockLanguageModelV3` path against fixtures mirroring the tracked upstream scenarios.
- **Build/deps**: `tsup`, ESM-only (`"type": "module"`, `sideEffects: false`), `engines.node >=18`, single hard peer dep on `ai >=5.0`. Lean dependency surface — no runtime deps beyond the `ai` peer.

## Relevance to kuralle / AriaFlow

Directly applicable: kuralle persists history in `SessionStore` and replays `ModelMessage[]` to providers across Anthropic/OpenAI/Google/xAI — exactly the surface that accumulates orphaned tool calls, unsigned reasoning, and duplicate results on retries/crashes (cf. the project's own W1 runtime-crash and exactly-once tool-execution work). `healMessages` is idempotent and safe to run both on the hot path and as an offline migration over persisted rows; `withHealing` is a one-line model wrapper. License (MIT) is compatible. The orphan-tool-use middleware caveat matters: in kuralle's runtime the heal must run on the stored `ModelMessage[]` before `streamText`, not only as model middleware.
