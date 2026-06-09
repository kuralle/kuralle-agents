# Firsthand Inspection — `@ai-sdk-tools/agents`

Inspected: `research/midday-ai-sdk-adoption/prior-art/clones/ai-sdk-tools/packages/agents`
Repo: `github.com/midday-ai/ai-sdk-tools` (monorepo), package dir `packages/agents`.
Date of inspection: 2026-06-09.

## License (verified)

- **Declared MIT** — `packages/agents/package.json` `"license": "MIT"` (verbatim, see snippet below).
- **No `LICENSE` file exists anywhere in the repo.** `find . -iname 'LICENSE*'` (excluding `node_modules`) returns nothing; there is no root `LICENSE`, no per-package `LICENSE`. The root `package.json` (`@ai-sdk-tools/root`, `private: true`) has **no `license` field at all**.
- Net: license is asserted only via the published package's `package.json` SPDX string. MIT is the stated intent, but there is **no license text bundled** to verify the grant. Worth noting if this matters for adoption/compliance.

## Maintenance signals

- **Version:** `1.2.0` (`package.json`). Note the CHANGELOG is internally inconsistent — top entries read `## 0.9.3`, `## 2.0.0` with a body "Release version 1.2.0" — changeset/versioning hygiene is messy.
- **Last touched (this package):** single squashed commit `a1cc555` "v1.2.0", **2025-11-21**. `git log --oneline -- packages/agents` returns exactly **1 commit** (this clone has a flattened history).
- **Tests:** **none.** No `*.test.ts` / `*.spec.ts` in the package, no `vitest`/`jest` dep, no `test` script in `package.json`. The only scripts are `build` (tsup), `dev`, `clean`, `type-check`.
- **Source size:** ~3,170 LOC across `src/`, dominated by `agent.ts` (1,672 LOC).
- **Deps:** `dependencies: {}`. AI SDK + zod are **peerDependencies** (`"ai": ">=5.0.0"`, `"zod": "^3.25.76 || ^4.1.8"`). Hard internal deps at runtime: `@ai-sdk-tools/debug` (logger) and `@ai-sdk-tools/memory` (working memory) — both imported unconditionally in `agent.ts`.

## AI-SDK-native?

**Yes — natively built on the Vercel AI SDK v5.** `agent.ts` imports a large surface directly from `"ai"`, including the experimental Agent class which it wraps:

```ts
// src/agent.ts:8-24
import {
  Experimental_Agent as AISDKAgent,
  convertToModelMessages,
  createUIMessageStream,
  createUIMessageStreamResponse,
  generateObject,
  generateText,
  type LanguageModel,
  type ModelMessage,
  type StepResult,
  stepCountIs,
  type Tool,
  tool,
  type UIMessage,
  type UIMessageStreamOnFinishCallback,
  type UIMessageStreamWriter,
} from "ai";
```

The package's own `Agent` is a thin orchestration layer over `ai`'s `Experimental_Agent`. Each `Agent` constructs an `AISDKAgent` (`new AISDKAgent<Record<string, Tool>>({ model, system, tools, stopWhen: stepCountIs(maxTurns||10), temperature })`, `agent.ts:105-110`), and the public `stream()` ultimately produces an AI-SDK `UIMessageStream` (`result.toUIMessageStream(...)`, `agent.ts:735`). Handoff tools are built with `ai`'s `tool()` + zod (`handoff.ts:1`, `:57`). Description string in `package.json`: "Multi-agent orchestration system built on AI SDK v5".

## API surface (real signatures)

Public exports (`src/index.ts`):

- `class Agent<TContext>` — the primitive. Constructed from `AgentConfig<TContext>`.
  - `async generate(options: AgentGenerateOptions): Promise<AgentGenerateResult>` (`agent.ts:116`)
  - `stream(options: AgentStreamOptions | { messages: ModelMessage[] }): AgentStreamResult` (`agent.ts:174`)
  - `toUIMessageStream(options: AgentStreamOptionsUI): Response` (`agent.ts:343`)
  - `getHandoffs(): Array<Agent<any>>` (`agent.ts:329`)
- `AgentConfig<TContext>` fields (`types.ts:80-118`): `name`, `instructions: string | ((ctx)=>string)`, `model: LanguageModel`, `tools?: Record<string,Tool> | ((ctx)=>Record<string,Tool>)`, `handoffs?: Array<Agent | ConfiguredHandoff>`, `handoffDescription?`, `maxTurns?`, `temperature?`, `modelSettings?`, **`matchOn?: (string | RegExp)[] | ((message: string) => boolean)`**, `onEvent?`, `inputGuardrails?`, `outputGuardrails?`, `permissions?`, `memory?`, `lastMessages?`.
- Routing helpers: `findBestMatch`, `matchAgent` (`routing.ts`).
- Handoff helpers: `createHandoff`, `createHandoffTool`, `handoff`, `getTransferMessage`, `isHandoffResult`, `isHandoffTool`, `HANDOFF_TOOL_NAME` (`handoff.ts`).
- Guardrails: `runInputGuardrails`, `runOutputGuardrails`, error classes (`AgentsError`, `MaxTurnsExceededError`, `ToolPermissionDeniedError`, `InputGuardrailTripwireTriggered`, etc.).
- Permissions: `checkToolPermission`, `createUsageTracker`, `trackToolCall`.
- Streaming UI helpers: `writeAgentStatus`, `writeDataPart`, `writeRateLimit`.
- `RECOMMENDED_PROMPT_PREFIX` / `promptWithHandoffInstructions` (handoff-prompt; note: defined and used internally, prefix not re-exported from index).

`HandoffInstruction` (`types.ts:120-129`): `{ targetAgent: string; context?: string; reason?: string; availableData?: Record<string,any> }`.

## Core mechanism — multi-agent: matchOn routing + handoffs

The orchestration is **hub-and-spoke**: one `Agent` acts as orchestrator, its `handoffs[]` are "specialists". Routing to a specialist happens by one of four strategies, evaluated in priority order inside the streaming loop (`agent.ts` ~485–676):

1. **`agentChoice`** (explicit/user-selected) → `routingStrategy: "explicit"`.
2. **`toolChoice`** → finds the specialist whose `configuredTools` contains the requested tool → `routingStrategy: "tool-choice"`.
3. **`strategy === "auto"` programmatic `matchOn`** → `routingStrategy: "programmatic"`. **No LLM call.** It iterates specialists and picks the first whose `matchOn` matches the raw user `input`:

```ts
// src/agent.ts:614-633
} else if (strategy === "auto" && specialists.length > 0) {
  // Try programmatic classification
  const matchedAgent = specialists.find((agent) => {
    if (!agent.matchOn) return false;
    if (typeof agent.matchOn === "function") {
      return agent.matchOn(input);
    }
    if (Array.isArray(agent.matchOn)) {
      return agent.matchOn.some((pattern) => {
        if (typeof pattern === "string") {
          return input.toLowerCase().includes(pattern.toLowerCase());
        }
        if (pattern instanceof RegExp) {
          return pattern.test(input);
        }
        return false;
      });
    }
    return false;
  });
```

Note: this inline matcher in the hot path uses `find` (first match wins, raw `toLowerCase().includes` for strings, `RegExp.test` for regex) and does **not** call the exported `routing.ts` helpers.

There is a **separate, richer scoring implementation** in `routing.ts` (`matchAgent` / `findBestMatch`) that normalizes text (lowercase, strips digits, collapses whitespace), weights longer string keywords higher and regex matches at `+2`, then picks the **highest-score** agent. It is exported but **not wired into the agent's own `stream()` loop** — the loop uses its own simpler inline first-match logic above. Both are purely string/regex/function based; **neither does any LLM classification.**

```ts
// src/routing.ts:57-76 — the exported (scoring) matcher, NOT used by Agent.stream
  // Array-based matching (strings and regex)
  for (const pattern of matchOn) {
    if (typeof pattern === "string") {
      // String keyword matching
      const normalizedPattern = normalizeText(pattern);
      if (normalizedMessage.includes(normalizedPattern)) {
        // Weight longer keywords higher (more specific)
        const weight = normalizedPattern.split(" ").length;
        score += weight;
      }
    } else if (pattern instanceof RegExp) {
      // Regex pattern matching
      if (pattern.test(normalizedMessage)) {
        score += 2; // Regex matches get higher weight
      }
    }
  }
  return { matched: score > 0, score };
```

### Handoffs (LLM-driven, via `HANDOFF_TOOL_NAME`)

When `matchOn` does not pre-route (or for orchestrator-driven flow), the **LLM** decides handoffs by calling a synthetic tool. When an agent has `handoffs[]`, a handoff tool is injected into its toolset under the key `HANDOFF_TOOL_NAME`:

```ts
// src/agent.ts:245-249
    // Add handoff tool if needed
    if (this.handoffAgents.length > 0) {
      resolvedTools[HANDOFF_TOOL_NAME] = createHandoffTool(this.handoffAgents);
      // Note: Agents communicate via conversationMessages during handoffs
    }
```

The constant and the tool (`handoff.ts`):

```ts
// src/handoff.ts:52-79
export function createHandoffTool(availableHandoffs: Array<Agent | ConfiguredHandoff>) {
  const agentNames = availableHandoffs.map((h) =>
    'agent' in h ? h.agent.name : h.name
  );
  return tool({
    description: `Transfer the conversation to another specialized agent.
    \nAvailable agents: ${agentNames.join(', ')}`,
    inputSchema: z.object({
      targetAgent: z.enum(agentNames as [string, ...string[]]),
      context: z.string().optional().describe("Context or summary to pass to the target agent"),
      reason: z.string().optional().describe("Reason for the handoff"),
    }),
    execute: async ({ targetAgent, context, reason }) => {
      // This will be handled by the runner
      return createHandoff(targetAgent, context, reason);
    },
  });
}
export const HANDOFF_TOOL_NAME = "handoff_to_agent";
```

Detection happens by watching the AI SDK stream for a tool result whose `toolName` is in a Set seeded with `HANDOFF_TOOL_NAME` (`agent.ts:751` `new Set([HANDOFF_TOOL_NAME])`, `:824` captures `handoffData = chunk.output as HandoffInstruction`). The handoff tool's output (a `HandoffInstruction`) is the routing signal. The orchestration loop (`while (round++ < maxRounds)`, `agent.ts:686`) then:
- guards against re-routing to an already-used specialist (`usedSpecialists` Set, `agent.ts:880`, `:1014`),
- applies a handoff **input filter** (per-handoff `config.inputFilter`, else `createDefaultInputFilter()`) to rewrite `conversationMessages` for the target (`agent.ts:904-971`),
- fires the optional `onHandoff` callback (`agent.ts:974`),
- sets `currentAgent = nextAgent` and emits a `data-agent-handoff` part with `routingStrategy: "llm"` (`agent.ts:983-994`).

The LLM is also nudged toward this protocol via a recommended system prefix (`handoff-prompt.ts:5`): "...Handoffs are achieved by calling a handoff function, generally named `handoff_to_agent`. Transfers between agents are handled seamlessly in the background; do not mention or draw attention to these transfers...".

### Summary of routing modes
| Strategy | Decider | Trigger |
|---|---|---|
| explicit (`agentChoice`) | caller | user picks agent name |
| tool-choice | code | requested tool lives on a specialist |
| **programmatic (`matchOn`)** | **code (string/regex/fn, NO LLM)** | `strategy:"auto"`, first specialist whose `matchOn` matches `input` |
| **handoff (`HANDOFF_TOOL_NAME`)** | **LLM** | model calls `handoff_to_agent` → `HandoffInstruction` |

## Key verbatim snippets (file:line)

1. License — `packages/agents/package.json`:
   `"license": "MIT",` (and root `package.json` has **no** license field; no `LICENSE` file in repo).

2. `matchOn` field declaration — `src/types.ts:104-105` / `src/agent.ts:64-66`:
   `matchOn?: (string | RegExp)[] | ((message: string) => boolean);`

3. Inline programmatic routing (NO LLM) — `src/agent.ts:618-630` (see block above): `if (typeof agent.matchOn === "function") return agent.matchOn(input);` ... `input.toLowerCase().includes(pattern.toLowerCase())` / `pattern.test(input)`.

4. Handoff tool name + tool factory — `src/handoff.ts:79` `export const HANDOFF_TOOL_NAME = "handoff_to_agent";` and `:57-73` (the `tool({...inputSchema: z.object({ targetAgent: z.enum(agentNames) ...})})`).

5. Handoff tool injection — `src/agent.ts:246-248`: `resolvedTools[HANDOFF_TOOL_NAME] = createHandoffTool(this.handoffAgents);`

## Adoption-relevant caveats

- Two divergent `matchOn` implementations (scoring `routing.ts` exported but unused by the runner; simpler first-match inline in `agent.ts`). Behavior depends on the inline one.
- No bundled LICENSE text despite MIT declaration.
- No tests in the package.
- Hard runtime coupling to sibling workspace packages `@ai-sdk-tools/debug` and `@ai-sdk-tools/memory` (not peer/optional — imported at top of `agent.ts`).
- Built on `ai`'s `Experimental_Agent`, so it inherits AI-SDK experimental-API churn risk.
