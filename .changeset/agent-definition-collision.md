---
'@kuralle-agents/core': major
---

Resolve the `AgentDefinition` collision inside `@kuralle-agents/core`.

Two unrelated types shared the name, both publicly reachable — `./foundation` exported `{ id, name, description?, prompt?, tools? }` and `./prompts` exported `{ identity, role, capabilities? }`. A user importing `AgentDefinition` got whichever one their import path happened to resolve, with no compile error either way. That is the `ToolTimeoutError` failure mode, on the framework's most on-the-nose name.

**Removed `foundation/AgentDefinition`.** Its doc described "the minimal shape every engine needs… Both Runtime (text) and VoiceEngine (audio) extend this" — a two-engine world that ended when voice was removed. Nothing extends it, nothing imports it, and it was never re-exported from the package root.

**Renamed the surviving one to `AgentIdentity`**, with `PromptBuilder.withAgentDefinition()` → `withAgentIdentity()` and the `agentDefinition` config key → `agentIdentity`. It is a prompt fragment, not an agent — `PromptBuilder` already rendered it into sections typed `identity` and `role`, so only the type name was out of step. The agent itself remains `AgentConfig` from `defineAgent`.

Migration: `import type { AgentIdentity } from '@kuralle-agents/core/prompts'` and call `.withAgentIdentity({ identity, role, capabilities })`. Anyone importing `AgentDefinition` from `@kuralle-agents/core/foundation` was importing a type with no consumers; drop it.
