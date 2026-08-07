---
'@kuralle-agents/core': major
---

**BREAKING — `StopConditions`, `EnforcementRules` and the legacy `RunContext` are removed.**

Three exported surfaces that were wired to nothing are gone:

- **`StopConditions`** — `maxSteps()`, `tokenBudget()`, `timeout()`,
  `consecutiveErrors()`, `loopDetection()`, `sameToolRepetition()`,
  `maxHandoffs()`, `taskComplete()`, `anyOf()`, `allOf()`,
  `defaultStopConditions`, `checkStopConditions`, and the `StopCondition` /
  `StopConditionResult` types.
- **`EnforcementRules`** (and the same names re-exported bare) — `readBeforeEdit`,
  `createRateLimitRule`, `createDependencyRule`, `contentValidation`,
  `createSequentialLimitRule`, `defaultEnforcementRules`.
- **`RunContext` as exported from `types/index.ts`** — the legacy shape with
  `stepCount` / `handoffStack` / `consecutiveErrors`. `RunContext` now resolves
  to exactly one type, the live one from `types/run-context.ts`, which is what
  the root index already exported.

Also removed, having no consumer once the above went: `ToolExecutor` and
`ExecutableTool` from `foundation/` (unrelated to `tools/effect/ToolExecutor`,
which is live), `isAbortSignal`, `InterruptionEvent`, `AbortOptions`,
`CancellationReason`, `Hook`, `StreamOptions`, `RefinementStageResult`,
`ValidationStageResult`, and `Session.pendingRefinement`.

**None of this was reachable.** `StopCondition` had zero call sites and there was
no config field to register one — `HarnessConfig.stopConditions`, which
`GUARDRAILS.md` documented, never existed. The helpers read `stepCount`,
`totalTokens` and `consecutiveErrors` off a `RunContext` shape the runtime does
not use. They shipped in the first commit and were never wired.

**What to use instead.** Structural limits were always enforced by the runtime
through `limits` on the agent, and still are:

```ts
// before — never had any effect
createRuntime({ agents, stopConditions: [StopConditions.maxSteps(15)] })

// after — the mechanism that actually runs
defineAgent({ id: 'triage', model, instructions, limits: { maxSteps: 15 } })
```

`ToolEnforcer` and `createToolEnforcer` are **unchanged and still live**; rules
go on `agent.guardrails.enforcement`. The rule *constructors* are gone with no
replacement — write the `EnforcementRule` objects your case needs.

`guides/GUARDRAILS.md` is rewritten against the real surface.
