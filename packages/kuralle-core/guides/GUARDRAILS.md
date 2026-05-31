# Guardrails Guide

Guardrails harden the runtime against loops, unsafe tools, and prompt injection.

## Stop Conditions

Built-in stop conditions live in `guards/StopConditions` and are enabled by default:
- `maxSteps`
- `tokenBudget`
- `timeout`
- `consecutiveErrors`
- `loopDetection`
- `maxHandoffs`

Override them via `HarnessConfig.stopConditions`.

```ts
import { StopConditions } from '@kuralle-agents/core';

const runtime = new Runtime({
  agents,
  defaultAgentId: 'triage',
  stopConditions: [
    StopConditions.maxSteps(15),
    StopConditions.timeout(60_000),
    StopConditions.maxHandoffs(5),
  ],
});
```

## Tool Enforcement Rules

`ToolEnforcer` supports call/result rules like rate-limits and dependency ordering.

```ts
import { EnforcementRules } from '@kuralle-agents/core';

const runtime = new Runtime({
  agents,
  defaultAgentId: 'triage',
  enforcementRules: [
    EnforcementRules.createSequentialLimitRule(2),
    EnforcementRules.createRateLimitRule('charge_card', 2, 60_000),
  ],
});
```

## Input & Output Processors

Processors allow allow/modify/block of input or output.

```ts
const runtime = new Runtime({
  agents,
  defaultAgentId: 'support',
  inputProcessors: [
    {
      id: 'block-secrets',
      process: async ({ input }) =>
        /api_key/i.test(input)
          ? { action: 'block', message: 'Do not share secrets here.' }
          : { action: 'allow' },
    },
  ],
});
```

## Output Redaction

`outputRedaction` is a defense-in-depth filter for streamed text.

```ts
const runtime = new Runtime({
  agents,
  defaultAgentId: 'support',
  outputRedaction: [
    { pattern: /\b\d{16}\b/, replacement: '[redacted]' },
  ],
});
```

## System Injections

Kuralle injects a few system-level guardrails by default (e.g. no secrets, invisible handoffs).
You can add your own via `InjectionQueue`.
