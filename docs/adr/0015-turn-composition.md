# ADR 0015 — Fixed turn-policy phases and separate lifecycle hooks

**Status:** Accepted · **Date:** 2026-07-25 · **Context:** RFC-0001 file-based agents; peer review of DeepAgents composition

## Context

Kuralle appears to have three mechanisms answering “what runs around a turn”:

1. `AgentConfig.guardrails.input` / `output` processors;
2. `AgentConfig.refine` / `validate` capabilities;
3. runtime hooks.

DeepAgents uses one ordered middleware stack for all three concerns. Copying that shape would give
one registration surface, but it would also make arbitrary middleware order responsible for
security redaction, model execution, output release, durability writes, and lifecycle telemetry.

The source contracts are not interchangeable:

| Surface | Context and authority | As-built order |
|---|---|---|
| Input/output processors | Deterministic message boundary transforms. They can allow, modify, or block; input modification is written back to both message mirrors and persisted immediately. They receive message history and processor context, but have no confidence or escalation decision. | Declaration order |
| Refinement/validation capabilities | Semantic policy decisions. Refinement can rewrite, block, or escalate a user message; validation additionally sees tool calls, citations, and flow state, and can rewrite, block, or escalate model output with confidence and audit records. | Sorted by capability name |
| `HarnessConfig.hooks` (`Hooks`) | Project-scoped operational lifecycle: run start/end, emitted parts, errors, and terminal conversation outcomes. Hooks observe the policy pipeline; they are not agent content policy. | Fixed runtime call sites outside the policy chain |

The processor action algebra is a subset of the capability decision algebra, but the mechanism is
not a strict subset: processors receive different context and own the immediate durable replacement
of sanitized input. Moving that responsibility into an arbitrary semantic policy would make
security and persistence order implicit. Hooks are not a subset of either because they observe
lifecycle events rather than decide content.

The source audit also found two hook types. `Runtime` and `HarnessConfig` use the five-method
`types/hooks.ts#Hooks`. The 21-method `types/runtime.ts#HarnessHooks` is used by the older
`createFoundation`/`HookRunner` surface; most of those methods are not invoked by `Runtime`.
RFC-0001 must not present that legacy interface as runtime turn composition.

## Decision

Keep the three responsibilities distinct and give the turn policy pipeline one fixed owner:

```
input processors
  → refinement capabilities
  → gather + model/tool execution
  → output processors
  → validation capabilities
```

This ordering is load-bearing:

- deterministic security transforms run before semantic refinement;
- sanitized input is persisted before model execution;
- output processors and validators run before their permitted streaming boundary is released;
- lifecycle hooks remain outside the agent policy pipeline.

Kuralle will not add a user-orderable middleware stack. This disagrees with DeepAgents deliberately:
its single stack is useful for homogeneous middleware, while Kuralle's stages have different
authority over durable state and output release. An arbitrary list would hide those phase
boundaries in ordering conventions.

RFC-0001 exposes one agent-level `policies.ts` singleton that supplies `guardrails`, `refine`, and
`validate` together. Project-level `hooks.ts` remains separate because it configures
`HarnessConfig.hooks`, not an `AgentConfig`. The file convention uses the actual `Hooks` contract
and does not discover or generate legacy `HarnessHooks`.

The optional `order` field on refinement/validation capabilities does not affect execution today;
file-based configuration must not imply otherwise. Changing within-phase ordering or making policy
execution user-orderable requires a separate runtime RFC.

## Consequences

- RFC-0001 has one place to inspect agent turn policy without conflating policy with operations.
- Existing runtime ordering and the durability journal are unchanged.
- Built-in guardrails retain immediate persistent redaction; semantic validators retain citations,
  confidence, audit, and escalation authority.
- Project hooks cannot be mistaken for per-agent middleware.
- The legacy `HarnessHooks` surface is explicitly outside file-based turn composition; this ADR does
  not claim its 21 methods are wired into `Runtime`.

## Rejected

- **One middleware stack.** Rejected because ordering would become a user-authored security and
  durability contract.
- **One file per phase (`refine.ts`, `validate.ts`, agent `hooks.ts`).** Rejected because it freezes
  implementation mechanisms into the project layout and incorrectly places project lifecycle hooks
  at agent scope.
- **Capabilities only.** Rejected because their context and decision contract does not own
  immediate persistent input sanitization.
