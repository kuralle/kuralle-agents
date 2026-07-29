# `@kuralle-agents/pi-driver`

Run Pi's agent/model/tool loop inside Kuralle without giving up Kuralle's typed
flows, durable effects, policies, routing, or stream contract.

```text
Kuralle Runtime
  input → policies → gather → Pi loop → output gate → validation → persistence
                              │
                              └─ every tool call returns through ctx.tool()
                                 (policy + approval + durable journal)
```

Pi is the inner execution engine. Kuralle remains the outer application runtime
and the only session/durability authority.

## Install

```bash
pnpm add @kuralle-agents/pi-driver @earendil-works/pi-agent-core @earendil-works/pi-ai
```

Pi `0.82.1` requires Node `>=22.19.0` when run on Node. Cloudflare Workers use
workerd rather than Node; see the Worker setup below.

## Basic use

Use Pi's current provider-scoped `Models` API. The temporary
`@earendil-works/pi-ai/compat` registry is deliberately not used by this driver.

```ts
import { openai } from '@ai-sdk/openai';
import { createRuntime, defineAgent } from '@kuralle-agents/core';
import { PiDriver } from '@kuralle-agents/pi-driver';
import { createModels } from '@earendil-works/pi-ai';
import { openaiProvider } from '@earendil-works/pi-ai/providers/openai';

const models = createModels();
models.setProvider(openaiProvider());
const piModel = models.getModel('openai', 'gpt-5-mini');
if (!piModel) throw new Error('Pi model is not registered');

const agent = defineAgent({
  id: 'support',
  name: 'Support',
  // Kuralle control services still use an AI SDK model. Speaking turns use Pi.
  model: openai('gpt-5-mini'),
  instructions: 'Help the customer clearly and concisely.',
});

const runtime = createRuntime({
  agents: [agent],
  defaultAgentId: agent.id,
  driver: new PiDriver({
    model: piModel,
    models,
  }),
});
```

`HarnessConfig.driver` applies to normal messages, flow turns, wake turns,
resumes, HTTP adapters, and the Cloudflare agent bridge. `runtime.run({ driver })`
still overrides it for one call.

### Per-node Pi model routing

The resolver sees the original AI SDK model, the node, the run context, and the
purpose of the call:

```ts
const driver = new PiDriver({
  models,
  model: ({ purpose, node }) => {
    const id = purpose === 'structured' ? 'gpt-5-mini' : 'gpt-5.2';
    const model = models.getModel('openai', id);
    if (!model) throw new Error(`Missing Pi model for ${node.id}`);
    return model;
  },
});
```

For a custom gateway or a deterministic test, pass `streamFn` instead of
`models`.

## Typed flows

There are two deliberate modes:

| `typedFlows` | Reply nodes | `collect` extraction | `decide` structured output |
|---|---|---|---|
| `'pi'` (default) | Pi | Pi submit tool, silent | Pi submit tool, schema-validated |
| `'ai-sdk'` | Pi | AI SDK | AI SDK `generateObject` |

Pi owns the complete model-facing channel by default. Use the hybrid compatibility
mode only when a provider's structured tool calling has not yet passed your evals:

```ts
const driver = new PiDriver({
  model: piModel,
  models,
  typedFlows: 'ai-sdk',
});
```

Pi-native collection never emits model prose: Kuralle still asks the authored
`collect.ask` question. Pi-native decisions expose a private required submit
tool, validate its arguments against the node schema, preserve Kuralle's closed
choice enum (including `__none`), and retain deterministic exact-choice matches.

This setting does not replace every control-model call in Kuralle. Optional
features such as compaction, fact-memory extraction, host guards, and goal
tracking may still use the AI SDK models configured on the agent/runtime.

## Cloudflare Durable Objects

`@kuralle-agents/cf-agent` already forwards `HarnessConfig.driver` through chat,
resume, and scheduled wake paths:

```ts
class SupportAgent extends KuralleAgent<Env> {
  protected getRuntimeConfig() {
    const models = createModels();
    models.setProvider(openaiProvider());
    const model = models.getModel('openai', 'gpt-5-mini');
    if (!model) throw new Error('Missing Pi model');

    return {
      driver: new PiDriver({
        model,
        models,
        getApiKey: () => this.env.OPENAI_API_KEY,
      }),
    };
  }
}
```

Use a recent compatibility date and `nodejs_compat`. Register only the provider
you need (`providers/openai`, `providers/anthropic`, and so on); importing
`providers/all` puts every provider SDK into the Worker graph.

The Durable Object owns single-writer session state and Kuralle's journal owns
application effects. Pi's in-memory transcript exists only for one Kuralle node
call. This avoids two competing recovery/session systems.

## Semantics preserved by the adapter

- Model tokens still pass through Kuralle's token/sentence/turn output gates.
- Tools still run through policy, human approval, timeouts, durable replay, and
  deterministic callsite reservation.
- Parallel-safe batches remain parallel; unsafe tools retain Kuralle ordering.
- `enter_flow`, handoff, end, escalation, and recovery results stop Pi before a
  second provider request and return as Kuralle `TurnControl`.
- A suspend/approval signal is never converted into a Pi error result or exposed
  to the user. Sibling tools settle first and Kuralle persists the continuation.
- AI SDK tool-call/tool-result history is retained for later Kuralle turns.
- Pi usage is projected into Kuralle model-call telemetry and turn accounting.

## Current boundaries

- AI SDK provider-defined tools cannot be adapted. Use Kuralle `defineTool`,
  which is also what gives tools durable/policy semantics.
- Text and base64/data-URL images are translated to Pi. Remote images are not
  fetched by the driver, and non-image files become attachment metadata; resolve
  or extract those inputs before the model turn when their contents are needed.
- Pi steering/follow-up queues are not exposed. Kuralle's per-session input inbox,
  wake scheduler, and host loop own cross-turn coordination.
- Kuralle's AI SDK provider-specific prompt-cache options are not translated.
  Pi receives the same stable prefix followed by volatile blocks, so automatic
  prefix caching can still apply, but explicit cache controls are provider/Pi-owned.
- Pi's higher-level `AgentHarness` is intentionally not used. Its persistence
  model would overlap with Kuralle's accepted journal and Durable Object state.
