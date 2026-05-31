# Kuralle Core Guides

Practical guides for the Kuralle core runtime and agent primitives.

## Guides

- **[Getting Started](./GETTING_STARTED.md)** - Minimal runtime with a single agent
- **[Runtime](./RUNTIME.md)** - Sessions, streaming, routing, hooks, and core options
- **[Flows](./FLOWS.md)** - Flow agents and structured conversations
- **[Tools](./TOOLS.md)** - Tool design, execution, and AI SDK integration
- **[Guardrails](./GUARDRAILS.md)** - Stop conditions, enforcement rules, processors, redaction
- **[Agents](./AGENTS.md)** - Agent types, consultation patterns, and team collaboration
- **[Example Verification](./EXAMPLE_VERIFICATION.md)** - Latest example sweep results and known prerequisites

## Examples

- `examples/` for runnable demos
- `examples/flows/` for Pipecat flow parity examples
- `examples/agents/` for Line example parity agents and integrations

### New in This Version

**Agent-to-Agent Consultation** (see AGENTS.md): Enables team collaboration where a lead agent can consult specialist agents directly using `runtime.runAgent()`. This pattern supports:

- Lead agent orchestration
- Direct specialist consultation
- Type-safe runtime access
- Single unified customer response

See [agent-consultation](../examples/agents/agent-consultation.ts) for a complete example.
