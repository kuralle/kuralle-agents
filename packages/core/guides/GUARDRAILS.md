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

## Built-in Guards (0.8.5)

Production-ready processors and validators ship with core — wire them into
`AgentConfig.guardrails` / `AgentConfig.validate`:

```ts
import {
  createPromptInjectionGuard,
  createPiiInputGuard,
  createPiiOutputGuard,
  createModerationGuard,
  createGroundingValidator,
} from '@kuralle-agents/core';

const agent = defineAgent({
  id: 'shop',
  instructions: '...',
  guardrails: {
    input: [
      createPromptInjectionGuard(),                  // deterministic injection patterns → block
      createPiiInputGuard(),                         // Luhn-checked cards + emails → redact (PCI default)
      createModerationGuard({ model: controlModel }), // LLM policy classifier → block
    ],
    output: [createPiiOutputGuard()],
  },
  validate: [
    // state-grounded "no invented actions" gate — rewrite-not-block
    createGroundingValidator({ model: controlModel }),
  ],
});
```

- PII detectors default to `['credit-card', 'email']`; `phone`/`iban` are
  opt-in (they collide with order ids). Cards are Luhn-validated, IBANs
  checksum-validated — order numbers don't false-positive.
- The moderation guard fails **open** by default (`onError: 'block'` for
  zero-tolerance deployments); deterministic guards still run during an
  outage.
- The grounding validator flags completed-action claims unsupported by this
  turn's tool calls, flow state, or citations and rewrites them out; if no
  safe rewrite exists, it blocks.
- A pre-turn block emits a `safety-blocked` stream part with the moderator id
  and rationale, then the user-facing message.

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
