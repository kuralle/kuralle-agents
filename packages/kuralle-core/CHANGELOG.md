# Changelog

## 2.0.0

### Breaking changes

Kuralle 2.0 is a complete rewrite of the agent runtime and authoring surface. v1 APIs are removed.

**Unified agent model**
- One primitive: `defineAgent` — no `type: 'llm' | 'flow' | 'triage' | 'composite'`
- Behavior derived from field presence: `instructions` + `tools`, `flows[]`, `routes[]`, `agents` / `handoffs`
- Flow nodes are single-job helpers: `reply`, `collect`, `action`, `decide`
- Transitions are returned control flow, not a separate edge table

**Runtime**
- `createRuntime` / `Runtime` / `HarnessConfig` / `RunOptions` (replaces `createV2Runtime`, `V2Runtime`, etc.)
- Imperative dispatch: `openRun` → `hostLoop` → `closeRun`
- Durable effect log for exactly-once tool execution, approval pauses, and replay
- `TurnHandle` from `runtime.run()` — await, iterate events, or `toResponseStream()`

**Channels**
- `TextDriver` and `VoiceDriver` implement `ChannelDriver` — same agent definition, both channels
- Voice uses provider-native realtime plugins; no separate `RealtimeRuntime`

**Tools**
- `defineTool` for effect tools with `needsApproval`, voice `interim`, Standard Schema
- AI SDK `tool()` continues to work as `ToolSet`; durable side effects use `tools`

**Removed (v1)**
- Agent classes: `LLMAgent`, `FlowAgent`, `TriageAgent`, `CompositeAgent`
- `FlowManager`, `FlowTraverser`, `OrchestrationAuthority`, `RealtimeRuntime`, `ProcedureRunner`
- Five-stage text pipeline, flow capability split, descriptor-based transitions

**Config**
- Packs load via `createRuntimeFromConfig`; pack agent shapes use `PackAgentConfig` internally
- `instructions` replaces `prompt` in pack JSONC (loader maps both during transition)

**Migration**
- Rename imports: `createV2Runtime` → `createRuntime`, `V2AgentConfig` → `AgentConfig`, etc.
- Replace agent `type` tags with unified `defineAgent` + `flows` / `routes` / `handoffs`
- Replace flow transition tables with returned node references in node handlers
