# @kuralle-agents/mcp

An MCP client for Kuralle agents. It runs on Cloudflare Workers, Node, and Bun, and it projects remote MCP tools into a `defineAgent` call.

## Install

```bash
npm install @kuralle-agents/mcp
```

This installs `@kuralle-agents/core`, `@kuralle-agents/plugins`, and `@modelcontextprotocol/client` (MIT) with it. Every `@kuralle-agents/*` package versions in lockstep, so install them at the same version.

## What it does

`mcpTools` connects a list of MCP servers and returns an `McpToolset` — a tool map you attach to an agent, and the `close()` that ends the connections behind it. Each remote tool is projected under the name `${server}__${tool}`.

**Key exports:**

- **`mcpTools(servers, opts?)`** — connect servers and return `McpToolset`.
- **`rebuildMcpToolsFromStorage(servers, opts, capabilities)`** — reconnect on wake from a persisted seed.
- **`createMemoryMcpConnectionStore` / `createSqliteMcpConnectionStore`** — connection stores for Node/Bun and for Durable Objects.
- **`composeMcpSystemPrompt`** — the MCP part of the system prompt.
- **`estimateTokens`**, **`DEFAULT_DISCLOSURE_BUDGET_TOKENS`**, **`MCP_DESCRIBE_TOOL`** — the disclosure budget surface.

## Usage

```ts
import { defineAgent } from '@kuralle-agents/core';
import { mcpTools } from '@kuralle-agents/mcp';

const { tools, close } = await mcpTools(
  [{ name: 'docs', type: 'streamable-http', url: 'https://mcp.example.com/mcp' }],
  {
    allowedHosts: ['mcp.example.com'],
    session,
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

Call `close()` when the session ends. The connections stay open until you do — dropping the reference does not close a socket or end an SSE stream.

## Credentials and session scope

`auth` runs **before** `initialize`, so the bearer covers the handshake and `tools/list`, not only `tools/call`. That is what an OAuth-protected server requires: it rejects the handshake, long before a tool call exists.

Resolving the credential at connect time fixes it onto the connection, so **a toolset built with `auth` belongs to one session**. Pass `session`, build one toolset per session, and `close()` it when the session ends. Supplying `auth` without `session` throws at wiring time rather than silently authenticating every user as whoever connected first.

```ts
async function toolsetFor(session: Session) {
  return mcpTools(servers, {
    session,
    allowedHosts: ['mcp.example.com'],
    auth: async (_server, ctx) => ({ token: await tokenFor(ctx.session) }),
  });
}
```

A server that needs no dynamic credential — static `headers` from `mcp.json`, or none at all — needs no session, and one process-wide toolset is correct for it.

`auth` is re-resolved on every call as well, layered over the connect-time credential, so a token rotated mid-session takes effect without a reconnect.

## Cancellation

The turn's `AbortSignal` reaches `tools/call`. When a turn is cancelled or a tool times out, the request to the MCP server is cancelled too — not just the promise on this side.

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
  session?: Session;               // required when `auth`, or a resolver `allowedHosts`, is set
  tools?: { allow?: readonly string[] } | { block?: readonly string[] };
  disclosure?: { budget?: number | 'auto'; alwaysLoad?: readonly string[] };
  timeoutMs?: number;              // default 60_000
  storage?: McpConnectionStore;
  onDiagnostic?: (d: Diagnostic) => void;
}
```

`tools` is a discovery filter and accepts either `allow` or `block`, never both. `auth` runs at connect time and again per call, never at parse time, and its result never reaches persisted run state.

## Tool names

A projected name is `${server}__${tool}` and is used verbatim, which is what keeps `Policy` rules and transcripts readable.

MCP puts almost no constraint on what a server may publish as a tool name; model providers require `^[a-zA-Z0-9_-]{1,64}$` and reject the whole request otherwise. A name that would be rejected — `search.docs`, a 90-character name, a non-ASCII one — is therefore rewritten: illegal characters become `_`, the name is clamped to 64, and a short deterministic hash of the original is appended so two remote tools cannot collide. The rewrite is stable across processes, because durable journal entries are written against it.

## Errors

MCP separates two failure kinds, and so does this client.

- A **protocol error** (unknown tool, malformed request) rejects the call.
- A **tool execution error** — a result with `isError: true` — also rejects, carrying the
  server's own message, prefixed `MCP tool error:`.

Every transport shares one result adapter, so this holds on stdio exactly as it does over
HTTP. It did not always: stdio had a second copy that never checked `isError`.

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

On a server so large that even names blow the budget, names are dropped too and the bare object schema is used. That bounds **schema bulk** at any tool count — the same budget applied twice, not a setting.

It does not bound the prompt. One floor applies to every tier: the **catalog** of every tool name and description is always present, because that is what the model routes on. The budget governs schema bulk on top of the catalog, never the catalog itself.

So a server broad enough for its catalog alone to exceed the budget is over budget with nothing left to shed. Trimming descriptions would buy the number back by destroying the routing signal, which is the wrong trade at any tool count. The client reports it instead — a `disclosure-budget-exceeded` diagnostic naming the tool count, the measured floor, and the `tools` filter as the way down — rather than implying a bound it cannot hold.

## Hibernation on Durable Objects

A Durable Object hibernates, so a live connection cannot survive in memory. Persist a seed and rebuild on wake.

```ts
import { createSqliteMcpConnectionStore, mcpTools, rebuildMcpToolsFromStorage } from '@kuralle-agents/mcp';

const store = createSqliteMcpConnectionStore(ctx.storage.sql);

// first run
const toolset = await mcpTools(servers, { storage: store, allowedHosts, session });

// after a wake
const rebuilt = await rebuildMcpToolsFromStorage(
  servers,
  { storage: store, allowedHosts, session },
  { stdio: false },
);
```

A Durable Object is itself the session boundary, so the session-scoped toolset lands here naturally: one DO, one session, one set of connections rebuilt on each wake.

Only an enumerated subset persists: `id`, `name`, `type`, `url`. No function, socket, header, or credential is ever written. Configured `headers` stay out on purpose — copying them into durable storage would widen a plaintext secret's blast radius from process memory to a database. You supply the config again on wake; the store records only *which* servers were connected.

`rebuildMcpToolsFromStorage` has no fallback to the supplied `servers` when the store is empty. A wake rebuilds what was persisted, and a cold start is `mcpTools`. They are different situations.

## Related

- [`@kuralle-agents/plugins`](https://www.npmjs.com/package/@kuralle-agents/plugins) — parse `mcp.json` from an Agent Plugin directory.
- [`@kuralle-agents/core`](https://www.npmjs.com/package/@kuralle-agents/core) — `defineAgent`, `Policy`, and the durable effect log.
- [`@kuralle-agents/cf-agent`](https://www.npmjs.com/package/@kuralle-agents/cf-agent) — Durable Object runtime.
