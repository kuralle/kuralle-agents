---
"@kuralle-agents/core": major
"@kuralle-agents/cf-agent": major
---

**Breaking:** remove the inert `HarnessHooks`/`HookRunner` lifecycle layer and its built-in logging, metrics, observability, and foundation implementations. Use runtime `tracing.sinks` with a `TraceSink`, `OtelTraceSink`, or `langfuseSink` for per-run, per-agent, and per-tool telemetry. Turn spans now carry the initiating `agentId`, and spans opened after a handoff carry the new active agent.
