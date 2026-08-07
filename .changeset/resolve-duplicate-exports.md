---
'@kuralle-agents/core': major
---

**BREAKING — every duplicate exported name in `core` is resolved. The allow-list is empty.**

Eight names each had two definitions reachable from `@kuralle-agents/core`. A
consumer imported the name, got one, and could hand it to code built against the
other. Four causes, resolved three different ways — mostly by deleting code that
was exported and used by nobody.

**`Tool` now means Kuralle's tool.** It didn't. The root index exported the AI
SDK's type explicitly while the framework's own effect-tool contract arrived via
`export type *`, so the explicit one won — `import { Tool }` gave you the AI
SDK's, and Kuralle's shipped under the alias `EffectTool`.

- `Tool` from `tools/Tool.ts` is renamed **`AiSdkTool`**, which is what it is.
- `Tool` now unambiguously means the effect-tool contract.
- **`EffectTool` is removed.** It existed only to dodge the collision and had
  zero consumers.

```ts
// before
import type { Tool, EffectTool } from '@kuralle-agents/core';
//            ^ the AI SDK's    ^ Kuralle's

// after
import type { AiSdkTool, Tool } from '@kuralle-agents/core';
//            ^ the AI SDK's  ^ Kuralle's
```

**`PromptSection` → `CapabilityPromptSection`** for the capability shape
(`{ role, content }`). The root index already exported it under that alias; only
the internal name disagreed. `PromptSection` now means the prompt-builder
section (`{ type: PromptSectionType }`) everywhere.

**`TracingConfig`, `Span`, `SpanEvent`, `MetricsConfig`, `ObservabilityMetrics`,
`Metrics`, `TraceStreamEvent`, `SessionTelemetry`, `SessionEndMetadata`,
`TracingService`, `InMemoryMetricsService`, `MetricsService`** are removed. The
two services were reachable only through the index and imported by nothing; the
types existed only to serve them. `SessionTrace.spans` went with them — a field
typed against that dead span model which nothing ever populated or read.

Live tracing is unchanged: `HarnessConfig.tracing`, `TraceStore`, `TraceSink`,
`AgentSpan`, `AgentTrace`.

**`HandoffInputData` / `HandoffInputResult` / `HandoffInputFilter`** had a second
copy in `types/processors.ts`, typed only to serve `AgentRoute` — which was
itself exported and used by nobody. Both are removed; the live definitions in
`runtime/handoffFilters.ts` remain, and `AgentRoute` is gone.

That duplicate was not cosmetic: it was **generating a cast**. The runtime holds
`ModelMessage[]`, the filter contract said `Array<Record<string, unknown>>`, and
`Runtime.ts` bridged them with `filtered.messages as ModelMessage[]` on the
handoff path. `HandoffInputData.messages` is now `ModelMessage[]` and the cast is
gone.

Migration is mechanical: rename `Tool` → `AiSdkTool` if you meant the AI SDK's,
`EffectTool` → `Tool` if you meant Kuralle's, and drop imports of the removed
tracing/metrics services. Nothing removed here had a caller.
