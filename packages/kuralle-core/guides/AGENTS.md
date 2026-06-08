# Agents Guide

Agent behavior in Kuralle is configured with a single primitive: `defineAgent()`. There is no `type` discriminator — capabilities come from which fields you pass.

```ts
import { createRuntime, defineAgent, defineFlow, reply, collect } from '@kuralle-agents/core';
import { openai } from '@ai-sdk/openai';

const model = openai('gpt-4o-mini');
```

## defineAgent

`defineAgent({ ... })` returns an `AgentConfig`. Pass one or more configs to `createRuntime({ agents: [...] })`.

| Fields | Effect |
|--------|--------|
| `id`, `model`, `instructions` | Base conversational agent |
| `tools`, `globalTools` | Durable tool access during free conversation and flow nodes |
| `flows` | Structured multi-step SOPs (`defineFlow` + node builders) |
| `routes`, `routing` | Route to flows or specialist agents |
| `agents` | Nested sub-agent configs for composition |
| `handoffs` | Explicit handoff targets (adds the invisible `handoff` tool) |

## Conversational agent

A conversational agent handles free-form dialogue. Omit `flows` and `routes`.

```ts
const supportAgent = defineAgent({
  id: 'support',
  name: 'Support Agent',
  instructions: 'You are a helpful support agent.',
  model,
  tools: { parse_date: dateParser },
});

const runtime = createRuntime({
  agents: [supportAgent],
  defaultAgentId: 'support',
  defaultModel: model,
});

const handle = runtime.run({ input: 'Hello', sessionId: 'demo' });
for await (const part of handle.events) {
  if (part.type === 'text-delta') process.stdout.write(part.delta);
}
await handle;
```

## Flow agent

Attach one or more flows with `flows: [ defineFlow({ ... }) ]`. Build nodes with `reply`, `collect`, `decide`, and `action`. The runtime emits `node-enter`, `flow-transition`, and `flow-end` events on the turn stream.

Hybrid mode (`hybrid: true` on `defineFlow`) lets the agent answer off-flow questions between steps and resume the SOP.

```ts
import { z } from 'zod';

const confirm = reply({
  id: 'confirm',
  instructions: 'Confirm the booking in one short sentence, then finish.',
  model,
  next: () => ({ end: 'booked' }),
});

const collectDate = collect({
  id: 'collect-date',
  schema: z.object({ date: z.string().min(1) }),
  required: ['date'],
  maxTurns: 4,
  instructions: () => 'Ask which date the user wants to book.',
  onComplete: () => confirm,
});

const bookingFlow = defineFlow({
  name: 'booking',
  description: 'Book an appointment',
  start: collectDate,
  nodes: [collectDate, confirm],
  hybrid: true,
});

const bookingAgent = defineAgent({
  id: 'booking',
  instructions: 'You are a booking assistant.',
  model,
  flows: [bookingFlow],
});

const runtime = createRuntime({
  agents: [bookingAgent],
  defaultAgentId: 'booking',
  defaultModel: model,
});
```

See [FLOWS.md](./FLOWS.md) for transition patterns and a full runnable example.

## Routing and triage

Add `routes`/`agents` to route user input to specialists. Routing is derived from shape: an agent with its own answering surface (instructions/flows/tools) folds an invisible `transfer_to_agent` tool into its turn; a routes-only agent with no answering surface becomes a silent **pure dispatcher**. Set `routing: { model }` to choose the control-reasoning model. Nest specialists in `agents`.

```ts
const billing = defineAgent({
  id: 'billing',
  name: 'Billing',
  instructions: 'You handle billing and payment questions.',
  model,
});

const support = defineAgent({
  id: 'support',
  name: 'Support',
  instructions: 'General support. Route billing questions to the billing specialist.',
  model,
  routes: [
    { agent: 'billing', when: 'billing, payment, invoice, or refund questions' },
  ],
  routing: { model },
  agents: [billing],
});

const runtime = createRuntime({
  agents: [support, billing],
  defaultAgentId: 'support',
  defaultModel: model,
});
```

The stream includes internal `{ type: 'handoff', targetAgent, reason }` events. Do not render these directly in user-facing transcripts.

You can also declare explicit handoff targets:

```ts
const agent = defineAgent({
  id: 'support',
  instructions: 'General support agent.',
  model,
  handoffs: ['booking', 'billing'],
});
```

Apply context filters on routes with `handoffFilters` (see README routing section).

## Composition

Nest sub-agents with `agents: [ defineAgent({ ... }) ]`. The runtime indexes nested configs by `id` for routing and handoffs.

```ts
const specialist = defineAgent({
  id: 'specialist',
  instructions: 'Domain expert.',
  model,
});

const lead = defineAgent({
  id: 'lead',
  instructions: 'Lead agent that coordinates specialists.',
  model,
  routes: [{ agent: 'specialist', when: 'specialist topic' }],
  agents: [specialist],
  routing: { model },
});
```

## Agent-to-Agent Consultation

Use specialist tools so a lead agent consults domain experts behind the scenes and synthesizes one unified response. This differs from routing handoffs: the customer stays with the lead agent.

### Pattern

```ts
import { generateText } from 'ai';
import { z } from 'zod';
import { buildToolSet, createRuntime, defineAgent, defineTool } from '@kuralle-agents/core';

const consultWeather = defineTool({
  name: 'consult_weather',
  description: 'Ask the weather specialist a question',
  input: z.object({ question: z.string() }),
  execute: async ({ question }) => {
    const { text } = await generateText({
      model,
      system: 'Weather expert. Brief factual answers.',
      prompt: question,
    });
    return { agentId: 'weather', response: text };
  },
});

const consultNews = defineTool({
  name: 'consult_news',
  description: 'Ask the news specialist a question',
  input: z.object({ question: z.string() }),
  execute: async ({ question }) => {
    const { text } = await generateText({
      model,
      system: 'News analyst. Brief factual summaries.',
      prompt: question,
    });
    return { agentId: 'news', response: text };
  },
});

const tools = { consult_weather: consultWeather, consult_news: consultNews };

const lead = defineAgent({
  id: 'lead',
  instructions:
    'Research assistant. Use consult_weather for weather and consult_news for news. Combine answers clearly.',
  model,
  tools: tools,
});

const runtime = createRuntime({
  agents: [lead],
  defaultAgentId: 'lead',
  defaultModel: model,
});

const handle = runtime.run({
  input: 'What is the weather in Paris and any big news today?',
  sessionId: 'demo',
});
for await (const part of handle.events) {
  if (part.type === 'text-delta') process.stdout.write(part.delta);
}
await handle;
```

### How It Works

1. **User talks to**: Lead agent
2. **Lead calls**: `consult_weather` or `consult_news` tool
3. **Tool executes**: Specialist logic (e.g. `generateText` with a domain system prompt)
4. **Result returned**: Structured tool result passed back to the lead agent
5. **Lead synthesizes**: Combines specialist outputs into one unified response

### Benefits

- **Single response** — Customer sees one answer from the lead agent
- **Team model** — Lead orchestrates specialists as one team
- **Composable** — Specialists are plain tools; no wrapper functions required
- **Session continuity** — Same `sessionId` across turns via `runtime.run`

### When to Use

- **Team collaboration** (specialist pattern): One lead agent + multiple domain tools
- **Product recommendations**, travel planning, research assistants

### When NOT to Use

- **Routing to a different agent persona** — Use `routes`/`agents` (derived routing) instead
- **Simple API calls** — Use `defineTool` / `createTool` directly without the specialist framing

### Example

See [standalone-agent.ts](../examples/agents/standalone-agent.ts) (Example 4) for a full working demo.

## Key Types

- `AgentConfig` — Agent configuration returned by `defineAgent`
- `Route`, `RoutingPolicy` — Routing declarations on an agent
- `Flow`, `FlowNode` — Flow graph types from `defineFlow` and node builders
- `HarnessStreamPart` — Stream event union (`text-delta`, `handoff`, `flow-transition`, etc.)
- `TurnHandle` — Return value of `runtime.run`; async iterable via `.events`
- `ToolExecutionOptions`, `ToolExecutionContext` — Tool execution context
- `getRuntimeFromContext()` — Read runtime from tool context when available

## Best Practices

1. **Keep SOPs in flows** — If instructions exceed ~20 lines of procedure, move them into flow nodes
2. **Use derived routing for triage** — Prevents user-visible handoff leaks
3. **Tools return data only** — No conversational text in tool outputs; flow tools return transitions
4. **Filter handoff context** — Use `handoffFilters` on routes when specialists need trimmed history
5. **Lead agent synthesizes** — Consultation tools return structured data; the lead agent speaks to the user

## Comparison to Other Patterns

| Pattern | Description | Handoffs | User sees |
|---------|-------------|----------|-----------|
| Agent Consultation | Lead calls specialist tools, synthesizes one answer | No | One agent |
| Derived routing | `routes`/`agents` route to a specialist (model-reasoned over `when`) | Yes (invisible) | Active specialist after route |
| Explicit handoffs | `handoffs: ['billing']` exposes the `handoff` tool | Yes (invisible) | Active specialist after handoff |
| Free conversation | No `flows` or `routes` | No | Same agent throughout |

**Agent consultation** keeps the customer with one lead persona. **Structured routing** transfers session control to a specialist when the topic matches.
