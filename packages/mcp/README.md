# @kuralle-agents/mcp

An MCP client for Kuralle agents. It runs on Cloudflare Workers, Node, and Bun, and it projects remote MCP tools into a `defineAgent` call.

## Install

```bash
npm install @kuralle-agents/mcp
```

This installs `@kuralle-agents/core`, `@kuralle-agents/plugins`, and `@modelcontextprotocol/client` (MIT) with it. Every `@kuralle-agents/*` package versions in lockstep, so install them at the same version.

## What it does

`mcpTools` connects a list of MCP servers and returns a tool map you attach to an agent. Each remote tool is projected under the name `${server}__${tool}`.

**Key exports:**

- **`mcpTools(servers, opts?)`** — connect servers and return `Record<string, AnyTool>`.
- **`rebuildMcpToolsFromStorage(servers, opts, capabilities)`** — reconnect on wake from a persisted seed.
- **`createMemoryMcpConnectionStore` / `createSqliteMcpConnectionStore`** — connection stores for Node/Bun and for Durable Objects.
- **`composeMcpSystemPrompt`** — the MCP part of the system prompt.
- **`estimateTokens`**, **`DEFAULT_DISCLOSURE_BUDGET_TOKENS`**, **`MCP_DESCRIBE_TOOL`** — the disclosure budget surface.

## Usage

```ts
import { defineAgent } from '@kuralle-agents/core';
import { mcpTools } from '@kuralle-agents/mcp';

const tools = await mcpTools(
  [{ name: 'docs', type: 'streamable-http', url: 'https://mcp.example.com/mcp' }],
  {
    allowedHosts: ['mcp.example.com'],
    auth: async () => ({ token: process.env.DOCS_TOKEN! }),
  },
);

const agent = defineAgent({
  id: 'research',
  model,
  instructions: 'Answer using the documentation tools.',
  tools,
  policy: {
    decide: (r) => (r.toolName.startsWith('docs__delete') ? { kind: 'ask' } : { kind: 'allow' }),
  },
});
```

## Runtime matrix

| Runtime | Transports | Import |
| --- | --- | --- |
| Cloudflare Workers / Durable Objects | `streamable-http`, `sse` | `@kuralle-agents/mcp` |
| Node | + `stdio` | `@kuralle-agents/mcp/node` |
| Bun | + `stdio` | `@kuralle-agents/mcp/node` |

The root export is fetch-only. `stdio` lives at the `/node` subpath because it pulls `cross-spawn`, which is not workerd-clean. Import `@kuralle-agents/mcp/node` once at startup on Node or Bun to register the transport.

A `stdio` server on Workers fails with a named error that states the transport, the runtime limit, and the remedy. Workers have no subprocess, so this is a platform limit and no install fixes it.

The root export needs the `nodejs_compat` flag on Workers. It imports `AsyncLocalStorage` from `node:async_hooks`.

## `McpOptions`

```ts
interface McpOptions {
  allowedHosts?: readonly string[] | ((server: string, ctx: { session: Session }) => readonly string[]);
  auth?: (server: string, ctx: { session: Session }) => Promise<{ token: string }>;
  tools?: { allow?: readonly string[] } | { block?: readonly string[] };
  disclosure?: { budget?: number | 'auto'; alwaysLoad?: readonly string[] };
  timeoutMs?: number;              // default 60_000
  storage?: McpConnectionStore;
  onDiagnostic?: (d: Diagnostic) => void;
}
```

`tools` is a discovery filter and accepts either `allow` or `block`, never both. `auth` runs at execute time, never at parse time, and its result never reaches persisted run state.

## Errors

MCP separates two failure kinds, and so does this client.

- A **protocol error** (unknown tool, malformed request) rejects the call.
- A **tool execution error** — a result with `isError: true` — also rejects, carrying the
  server's own message, prefixed `MCP tool error:`.

The second case matters more than it looks. Those messages are written for the model to
correct against: *"Invalid departure date: must be in the future."* Returning that text as
an ordinary value would tell the model the call succeeded and record a success in the
durable journal, so a replay would skip a call that never worked.

## Security posture

- **`Policy` is the only approval gate.** Every MCP tool call passes through `Policy.decide`. A `deny` prevents execution and the server receives nothing.
- **Tool annotations are never trusted.** A malicious server can mark a destructive tool read-only, so annotations play no part in an approval decision.
- **Server `instructions` are never forwarded** into the system prompt. They are third-party text and would be a prompt-injection seam.
- **`allowedHosts` is an SSRF guard.** A plugin file supplies the URL, so a host outside the list fails with no outbound request.
- **stdio `env` is an allowlist**, not an inherit.

## Disclosure budget

A broad server can publish hundreds of tools. Injecting every schema into every prompt is the cost progressive disclosure exists to avoid.

This is one code path with a threshold, not a mode flag. The decision is per server:

```
if tokensOf(server's tool definitions) <= budget  or  server in alwaysLoad:
    project each tool with its full input schema
else:
    project each tool with a deferred schema, and add MCP_DESCRIBE_TOOL
```

Every tool keeps its real `${server}__${tool}` name in both cases, so `Policy` still discriminates by name and transcripts still record what ran.

The default budget is `20_000` tokens, about 10% of a 200k context window. `estimateTokens` is a deliberate four-characters-per-token approximation, not a tokenizer, because the threshold is an order-of-magnitude decision and the root export must stay dependency-free.

A deferred tool sheds schema **prose**, not the argument **contract**. It keeps parameter names, their scalar types and `required`, and drops descriptions, enums, formats and nested bodies. `mcp__describe_tool` still returns the full schema.

That split is load-bearing. An earlier version replaced the whole schema with `{ type: 'object' }`; with no parameter names at generation time the model produced a malformed call in **2 of 5** live runs, against **0 of 5** once names were kept.

On a server so large that even names blow the budget, names are dropped too and the bare object schema is used. That holds the budget at any tool count — the same budget applied twice, not a setting.

One floor applies to both tiers: the **catalog** of every tool name and description is always in the prompt, because that is what the model routes on. The budget governs schema bulk on top of the catalog, not the catalog itself.

## Hibernation on Durable Objects

A Durable Object hibernates, so a live connection cannot survive in memory. Persist a seed and rebuild on wake.

```ts
import { createSqliteMcpConnectionStore, mcpTools, rebuildMcpToolsFromStorage } from '@kuralle-agents/mcp';

const store = createSqliteMcpConnectionStore(ctx.storage.sql);

// first run
const tools = await mcpTools(servers, { storage: store, allowedHosts });

// after a wake
const rebuilt = await rebuildMcpToolsFromStorage(servers, { storage: store, allowedHosts }, { stdio: false });
```

Only an enumerated subset persists: `id`, `name`, `type`, `url`. No function, socket, header, or credential is ever written. Configured `headers` stay out on purpose — copying them into durable storage would widen a plaintext secret's blast radius from process memory to a database. You supply the config again on wake; the store records only *which* servers were connected.

`rebuildMcpToolsFromStorage` has no fallback to the supplied `servers` when the store is empty. A wake rebuilds what was persisted, and a cold start is `mcpTools`. They are different situations.

## Related

- [`@kuralle-agents/plugins`](https://www.npmjs.com/package/@kuralle-agents/plugins) — parse `mcp.json` from an Agent Plugin directory.
- [`@kuralle-agents/core`](https://www.npmjs.com/package/@kuralle-agents/core) — `defineAgent`, `Policy`, and the durable effect log.
- [`@kuralle-agents/cf-agent`](https://www.npmjs.com/package/@kuralle-agents/cf-agent) — Durable Object runtime.
