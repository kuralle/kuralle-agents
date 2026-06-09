# hyper — firsthand inspection (MCP projection focus)

Repo: `research/midday-ai-sdk-adoption/prior-art/clones/hyper`
Inspected: 2026-06-09 (git HEAD `a9785f4`, 2026-05-24)

## License — VERIFIED: MIT

The task brief declared "NONE (no declared license)" — **this is wrong**. There IS a license.

- Repo-root `LICENSE` is a full **MIT License**, `Copyright (c) 2026 Midday Labs AB` (verbatim `cat LICENSE`).
- No root `package.json` exists, but every package declares MIT, e.g. `packages/mcp/package.json`: `"license": "MIT"`.

This is a Midday Labs project (the same org behind midday/Bun-AI tooling).

## What it is

`hyper` is an AI-native Bun-only API framework. One fluent route definition projects into multiple surfaces: HTTP (`Bun.serve`), OpenAPI 3.1, a typed RPC client manifest, and an **MCP tool manifest**. Distribution is **vendored-source / shadcn-style**: packages ship raw `src/` and point `exports.types`/`import` directly at `./src/index.ts` (`packages/mcp/package.json`: `"files": ["src", ...]`, `"import": "./src/index.ts"`), so consumers `hyper add mcp` to copy source in rather than installing a compiled dep.

## Core mechanism — MCP projection

Three stages, all opt-in and routed through one shared dispatch.

**1. Opt-in annotation.** A route joins the MCP surface only if its meta carries `mcp: { description }`. The `route.resource(...)` helper sets it automatically when `opts.mcp` is true (`packages/core/src/resource.ts:49-50`); otherwise the author writes `.meta({ name, mcp: { description } })` (see test below).

**2. Manifest projection (`@hyper/core`).** `toMCPManifest(routes)` walks every route, **skips `meta.internal`**, keeps only routes with `meta.mcp`, and emits a `MCPManifest` (`version: "1.0"`, `tools: MCPTool[]`). Each tool name defaults to `<method>_<sanitized-path>`. `inputSchema` is a coarse `type: "object"` with `params`/`query`/`body` sub-objects present only when the route declares those schema slots — note it does **not** inline the Standard Schema; it just signals which of the three input buckets exist. `app.toMCPManifest()` binds this over the app's full route list (`packages/core/src/app.ts:196`).

**3. Transport (`@hyper/mcp`).** `mcpServer(app)` builds a minimal **JSON-RPC 2.0** server (HTTP POST / stdio) implementing exactly `initialize`, `tools/list`, `tools/call`. `tools/call` does NOT re-implement handler logic — it funnels through `app.invoke({ method, path, params?, query?, body? })`, which reconstructs a real `Request` and runs the **same `fetch` pipeline once** (`packages/core/src/app.ts:159-192`), so middleware, validation, and logging execute exactly as for HTTP. Result `status >= 400` becomes a JSON-RPC error; otherwise the JSON body is wrapped as `{ content: [{ type: "text", text: JSON.stringify(output) }] }`. Optional `cfg.authorize({ toolName, req })` gates each call.

**CLI.** `hyper mcp` loads the app entry, requires `@hyper/mcp` to be installed (`hyper add mcp`), then `Bun.serve({ fetch: server.handle })` on port 5174. Two introspection flags: `--manifest` (dump JSON manifest, no serve) and `--audit` (print the exposed surface + inferred auth, no serve) via `auditMcp` / `formatAuditHuman` (`packages/cli/src/commands/mcp.ts`).

## API surface (real signatures)

`@hyper/mcp` (`packages/mcp/src/index.ts`):
```ts
function mcpServer(app: HyperApp, cfg?: McpServerConfig): McpServer
interface McpServer {
  handle: (req: Request) => Promise<Response>          // JSON-RPC over POST
  manifest: MCPManifest
  listTools: () => readonly { name: string; description: string }[]
  callTool: (name: string, args: unknown) => Promise<unknown>
}
interface McpServerConfig {
  manifest?: MCPManifest
  authorize?: (a: { toolName: string; req: Request }) => boolean | Promise<boolean>
  info?: { name: string; version: string }
}
function auditMcp(app: HyperApp): AuditReport
function formatAuditHuman(report: AuditReport): string
```

`@hyper/core` projection (`packages/core/src/projection.ts`):
```ts
interface MCPManifest { readonly version: "1.0"; readonly tools: readonly MCPTool[] }
interface MCPTool {
  readonly name: string; readonly description: string
  readonly method: string; readonly path: string
  readonly inputSchema: { type: "object"; properties: Record<string, unknown> }
}
function toMCPManifest(routes: readonly Route[]): MCPManifest
// on the app:  app.toMCPManifest(): MCPManifest   (app.invoke(): shared HTTP/RPC/MCP dispatch)
```

## AI-SDK-native? — NO

`hyper` does **not** import `ai` / `@ai-sdk/*` and does not depend on the Vercel AI SDK anywhere. "AI-native" here means *the API is projected as MCP tools an agent can call*, not that it embeds the AI SDK. The one near-miss is `packages/log/src/ai.ts`, a structural logging proxy for any model-like object that explicitly states: *"We stay deliberately structural: we don't import `ai` to keep peer deps optional. Users pass their model-like object."* So even the model-logging helper avoids an AI-SDK dependency by design.

## Verbatim source snippets

`packages/core/src/projection.ts:169-191` — the projection filter:
```ts
export function toMCPManifest(routes: readonly Route[]): MCPManifest {
  const tools: MCPTool[] = []
  for (const r of routes) {
    if (r.meta.internal) continue
    if (!r.meta.mcp) continue
    const cfg = r.meta.mcp as { description: string }
    tools.push({
      name: r.meta.name ?? `${r.method.toLowerCase()}_${r.path.replace(/[^a-z0-9]+/gi, "_")}`,
      description: cfg.description,
      method: r.method,
      path: r.path,
      inputSchema: {
        type: "object",
        properties: {
          ...(r.params ? { params: { type: "object" } } : {}),
          ...(r.query ? { query: { type: "object" } } : {}),
          ...(r.body ? { body: { type: "object" } } : {}),
        },
      },
    })
  }
  return { version: "1.0", tools }
}
```

`packages/mcp/src/server.ts:50-69` — `tools/call` funnels through the shared dispatch:
```ts
const callTool = async (name: string, args: unknown): Promise<unknown> => {
  const tool = byName.get(name)
  if (!tool) throw rpcError(-32601, `unknown tool: ${name}`)
  const input = (args ?? {}) as { params?: ...; query?: ...; body?: unknown }
  const result = await app.invoke({
    method: tool.method as HttpMethod,
    path: tool.path,
    ...(input.params && { params: input.params }),
    ...(input.query && { query: input.query }),
    ...(input.body !== undefined && { body: input.body }),
  })
  if (result.status >= 400) {
    throw rpcError(-32000, `tool failed with ${result.status}`, result.data)
  }
  return result.data
}
```

`packages/mcp/src/server.ts:94-113` — JSON-RPC `tools/list` + `tools/call` arms:
```ts
case "tools/list":
  return rpcOk(msg.id ?? null, {
    tools: manifest.tools.map((t) => ({
      name: t.name, description: t.description, inputSchema: t.inputSchema,
    })),
  })
case "tools/call": {
  const params = (msg.params ?? {}) as { name: string; arguments?: unknown }
  if (cfg.authorize) {
    const ok = await cfg.authorize({ toolName: params.name, req })
    if (!ok) return rpcErr(msg.id ?? null, -32001, `unauthorized: ${params.name}`)
  }
  const output = await callTool(params.name, params.arguments)
  return rpcOk(msg.id ?? null, { content: [{ type: "text", text: JSON.stringify(output) }] })
}
```

`packages/log/src/ai.ts:7-9` (the deliberate non-dependency on the AI SDK):
```
 * We stay deliberately structural: we don't import `ai` to keep peer deps
 * optional. Users pass their model-like object; we proxy the `doGenerate`
 * / `doStream` calls.
```

`packages/mcp/src/__tests__/mcp.test.ts:7-19` — how a route opts in (the public authoring API):
```ts
route.get("/users")
  .meta({ name: "users.list", mcp: { description: "List users" } })
  .handle(() => ok([{ id: "u1" }])),
// ...
route.get("/health").handle(() => ok({ ok: true })), // not MCP-exposed
```

## Maintenance signals

- **Version:** `0.1.0` across all packages; CHANGELOG `[0.1.0] - 2026-04-23` "Initial public preview." Single-version monorepo (Bun workspaces).
- **Recency:** last commit `a9785f4`, 2026-05-24 (~2 weeks before inspection). Active.
- **Tests:** `packages/mcp/src/__tests__/mcp.test.ts` has 7 tests covering manifest filtering, `tools/list`, `tools/call`→`app.invoke`, audit, and not-exposed routes. I could **not run** them in the fresh clone (`bun test` failed with `Cannot find module '@hyper/core'` — workspace deps require `bun install` first, which I did not run). So tests *exist and are well-targeted*, but I did not observe them green.
- **Tooling:** biome, lefthook, renovate, `tsgo`/tsc typecheck per package. CI under `.github/`.

## Relevance to AriaFlow / kuralle

The interesting transferable idea is the **single shared dispatch** (`app.invoke`) reused across HTTP / RPC / MCP / actions, so MCP tool calls inherit the exact middleware + validation path with zero duplication — and **opt-in projection** (`meta.mcp`, `meta.internal` exclusion, `--audit` to see the exposed surface before shipping). It is NOT an AI-SDK integration; it is a thin JSON-RPC 2.0 MCP server over an HTTP framework. The `inputSchema` projection is coarse (object-presence only, no Standard Schema inlining), which is a notable gap if agents need real argument schemas.
