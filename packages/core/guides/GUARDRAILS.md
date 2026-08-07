# Guardrails Guide

Guardrails harden the runtime against loops, runaway cost, unsafe tools, and
prompt injection. Everything here is configured on the **agent**, not on
`createRuntime`.

## Limits

The structural stop conditions. They are enforced by the runtime itself, not by
anything you register:

```ts
import { defineAgent } from '@kuralle-agents/core';

const agent = defineAgent({
  id: 'triage',
  model,
  instructions: 'Route the customer.',
  limits: {
    maxTurns: 20,             // turns in one session
    maxSteps: 25,             // model steps in one turn
    toolMaxSteps: 10,         // tool-calling steps in one turn
    maxOscillations: 3,       // repeated back-and-forth between two agents
    maxToolConcurrency: 8,    // parallel-safe tools running at once
    maxToolResultTokens: 8000 // ceiling on ONE tool result as the model sees it
  },
});
```

`maxToolConcurrency` defaults to 8. Raise it deliberately — the model's batch
size must never be the concurrency policy, and above eight the session store's
CAS starts rejecting concurrent writes.

`maxToolResultTokens` bounds only what the **model** sees. The durable journal
and `ctx.tool()` always keep the full value, so truncation never loses data.

## Tool enforcement rules

`ToolEnforcer` applies call- and result-time rules — rate limits, dependency
ordering, sequential caps. Rules go on the agent's `guardrails.enforcement`:

```ts
const agent = defineAgent({
  id: 'billing',
  model,
  instructions: 'Handle billing.',
  guardrails: {
    enforcement: [myRateLimitRule, myDependencyRule],
  },
});
```

An `EnforcementRule` is a plain object you write; the framework ships the
enforcer, not a rule library. `createToolEnforcer(rules)` is exported if you
need to drive one directly.

## Input and output processors

Processors allow, modify, or block input before a turn and output after it:

```ts
guardrails: {
  input: [myInjectionScanner],
  output: [myPiiRedactor],
}
```

## Policy — the tool boundary

For allow/ask/deny decisions per tool call, use `Policy` rather than a
guardrail. It is the enforcement point the rest of the framework defers to:
`needsApproval: true` on a tool is sugar for a policy returning `ask`. See
`/guides/policy`.

---

## Removed in 0.21.0

`StopConditions` (`maxSteps()`, `tokenBudget()`, `timeout()`,
`consecutiveErrors()`, `loopDetection()`, `maxHandoffs()`, `taskComplete()`,
`anyOf()`, `allOf()`, `defaultStopConditions`, `checkStopConditions`) and
`EnforcementRules` (`readBeforeEdit`, `createRateLimitRule`,
`createDependencyRule`, `contentValidation`, `createSequentialLimitRule`,
`defaultEnforcementRules`) are gone.

An earlier version of this guide said the stop conditions were "enabled by
default" and configured through `HarnessConfig.stopConditions`. **Neither was
true.** No such config field ever existed, nothing in the runtime ever called a
`StopCondition`, and the helpers read fields (`stepCount`, `totalTokens`,
`consecutiveErrors`) off a context shape the live runtime does not use. They
were exported from the first commit and wired to nothing.

Use `limits` above — that is, and always was, the mechanism that actually runs.
The rule constructors have no replacement; write the `EnforcementRule` objects
your case needs and pass them through `guardrails.enforcement`.
