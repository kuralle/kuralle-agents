# BUILD-READY — first commits for the top-2 adoptions

For the #1 (`ai-sdk-heal` → pairing-integrity port) and #2 (`hyper` → MCP-projection port) decisions only. Each has a green-light check (must all pass to start) and the literal first 3 commits, grounded in kuralle's verified seams.

Seams were verified firsthand in this repo:
- `ToolExecutor.executeInner` calls `def.execute(sanitizedArgs, toolCtx)` at **ToolExecutor.ts:162**, `validateOutput` at **:211**, `toolCallId → requestId` at **:93**.
- `toolToAiSdk` strips `execute` (`execute?: never`, **defineTool.ts:55**) — confirms the libs' Tool.execute-layer mechanism has nothing to grab in kuralle's model path.
- `applyPromptCache` is at **promptCache.ts:197**, called at **TextDriver.ts:78** (`applyPromptCache(model, ctx.session.id, messages)`).
- `handoffFilters.ts`: `removeToolHistory` :45, `keepRecentMessages` :68, `HandoffInputFilter` type :33, barrel `handoffFilters` :135. **`HandoffInputFilter` is never invoked** — `select.ts`'s only `.filter` calls are array ops on `flows`/`routes`/`parts`. The orphan path is dormant.
- `harnessToUIMessageStream` + `KuralleDataParts` union at **uiMessageStream.ts:13/177**; `data-kuralle-*` parts confirmed.
- hono-server exports `createKuralleChatRouter` family from `index.ts`; `AgentConfig.tools` (:31) / `globalTools` (:37); `z.toJSONSchema` available (zod4, used gemini.ts:22).

---

## #1 — ai-sdk-heal → pairing-integrity port

### Green-light check (all must be true to start)
- [x] **License clear** — full MIT LICENSE text shipped (`Copyright (c) 2026 Pontus Abrahamsson`), verified two ways. Port reads the idea; we write kuralle code regardless.
- [x] **Seam exists** — `handoffFilters.ts:45` (`removeToolHistory`) is the orphan-capable path; `applyPromptCache` (promptCache.ts:197) is the pre-cache pipeline for the reasoning guard.
- [ ] **STEP 0 repro is RED first** (CLAUDE.md §10) — a failing test that wires `removeToolHistory` across a handoff and observes an orphaned-tool-call 400 (or a constructed orphaned `ModelMessage[]` that `assertNoOrphans` must reject). **Do not write the fix before this is red.**
- [x] **Invariant safety understood** — heal runs BEFORE `applyPromptCache`; never touches cached-message identity; purely structural (ADR-0007-safe); **stub-result rule explicitly excluded** (effect-log owns exactly-once — drop the orphan, never fabricate a failure).

### First 3 commits

**Commit 1 — `test: red repro for orphaned tool-call after handoff filter`**
- *New:* `packages/kuralle-core/src/runtime/__tests__/handoffFilters.orphans.test.ts`
- Construct a `HandoffInputData.messages` `ModelMessage[]` where an assistant message carries a `tool-call` part whose matching `role:'tool'` result is in a later message; run `removeToolHistory` with the "preserve mixed assistant message" branch active so the result is dropped but the call survives.
- Assert the output **still contains an orphaned tool-call** (today: true → the test documents the latent bug). Add a second case: a constructed `ModelMessage[]` with an orphaned `tool-result` (no preceding call).
- *Verify gate:* test is RED against current `removeToolHistory`. This is the loop; no fix lands without it.

**Commit 2 — `feat(runtime): assertNoOrphans + pairing-drop in handoffFilters`**
- *Edit:* `packages/kuralle-core/src/runtime/handoffFilters.ts`
- Add a shared pure helper `assertNoOrphans(messages): { messages; dropped }` modeled on heal's idempotent `healToolPairing` shape (MIT idea, kuralle code): walk messages, pair `tool-call` ↔ `tool-result` by `toolCallId`; when a result is cut, drop its call; when a call is cut, drop its result. Return a new array (never mutate).
- Call it at the tail of `removeToolHistory` (:45) **and** `keepRecentMessages` (:68) so both mutation paths exit pairing-clean.
- *Reject:* heal's `stub-result` — do **not** insert a fabricated `error-text` tool-result. Drop the orphaned call instead (keeps the prefix honest; effect-log may legitimately complete the call on retry).
- *Verify gate:* Commit 1 test goes GREEN; `assertNoOrphans` is idempotent (running twice == once); existing handoffFilters tests still pass.

**Commit 3 — `feat(runtime): reasoning-signature pre-flight in applyPromptCache` *(only if STEP 0 reproduced a reasoning 400)***
- *Edit:* `packages/kuralle-core/src/runtime/promptCache.ts` (inside the `applyPromptCache` pipeline, :197) — add a structural pre-flight, gated by an `inferProvider`-style check, that asserts Anthropic extended-thinking signature presence (port heal's forgiving `hasAnthropicSignature`: accept signature under `providerOptions` OR `providerMetadata`, treat `redactedData` as valid) and OpenAI trailing-reasoning presence. Drop unsigned/trailing reasoning parts; **run before cache markers are applied**, and never alter the identity of the messages carrying a `cacheControl` marker.
- *Edit:* `TextDriver.ts:78` call site stays unchanged (heal already runs inside the pipeline it invokes).
- *Verify gate:* a live Anthropic multi-turn prompt-cached turn does not 400 on reasoning; **prompt-cache hit-rate is unchanged** — assert the cached-token count on turns 2–4 is stable (the guard must not shift the cached prefix). If STEP 0 did not reproduce a reasoning 400, **skip this commit** (latent, not live — don't write a fix for an unobserved bug).

---

## #2 — hyper → MCP-projection port

### Green-light check (all must be true to start)
- [x] **License clear** — full MIT LICENSE (`Copyright (c) 2026 Midday Labs AB`), verified firsthand. We write kuralle code, not `@hyper/mcp` (it's bound to `HyperApp`/`app.invoke()`, which kuralle lacks).
- [x] **Live gap confirmed** — grep `packages/*/src` for `mcp|modelcontextprotocol` = 0 hits. No client, no server.
- [x] **Projectable unit identified** — `AgentConfig.tools` (:31) + `globalTools` (:37); each `AnyTool` carries `name`/`description`/`input` Standard Schema via `defineTool`. Mount seam: beside `createKuralleChatRouter` in `kuralle-hono-server/src/index.ts`.
- [x] **Exactly-once edge understood** — `tools/call` must funnel through a **real durable tool turn** keyed into the effect log (ToolExecutor, `toolCallId`-keyed :93), not a raw re-dispatch; mutating exposure requires session + idempotency key.

### First 3 commits

**Commit 1 — `feat(core): mcpExposed opt-in flag + projectMcpManifest`**
- *Edit:* `packages/kuralle-core/src/tools/effect/defineTool.ts` — add an opt-in `mcpExposed?: { description?: string }` to the config (default-deny: absent = not projected; mirrors hyper's `if (!r.meta.mcp) continue`, projection.ts:172–174, and kuralle's `globalTools` allow-list discipline).
- *New:* `packages/kuralle-core/src/mcp/projectManifest.ts` — `projectMcpManifest(agent: AgentConfig): McpManifest` walking `tools` + `globalTools`, keeping only `mcpExposed` tools. **Improve on hyper:** inline each tool's Standard Schema as JSON Schema via `z.toJSONSchema` (zod4, per gemini.ts:22) for a real `inputSchema` — not hyper's coarse object-presence stub. Derive the MCP tool name from the tool's declared `name`, never from lexical/path inspection (ADR-0007: no lexical-routing backdoor).
- *New:* `packages/kuralle-core/src/mcp/__tests__/projectManifest.test.ts` — default-deny (un-flagged tool absent); a flagged tool emits inlined JSON Schema; a consequential/mutating tool left un-flagged is invisible.
- *Verify gate:* tests green; an un-flagged tool never appears in the manifest.

**Commit 2 — `feat(hono-server): createKuralleMcpRouter (JSON-RPC 2.0)`**
- *New:* `packages/kuralle-hono-server/src/mcpRouter.ts` — `createKuralleMcpRouter({ runtime, authorize? })` implementing exactly `initialize` / `tools/list` / `tools/call` (port hyper's minimal JSON-RPC shape, server.ts:94–113). `tools/list` returns `projectMcpManifest(...)`. `tools/call` **funnels through a real durable tool turn** via the runtime (NOT raw re-dispatch) so validation + effect-log + middleware run exactly as a normal turn; `status >= 400` → JSON-RPC error. Per-call `authorize({ toolName, req })` gate (port hyper's `cfg.authorize`).
- *Edit:* `packages/kuralle-hono-server/src/index.ts` — export `createKuralleMcpRouter` + options type beside the existing chat-router exports.
- *Verify gate:* live smoke from a neutral cwd — an external MCP client calls `tools/list` then `tools/call` on a **read-only** tool and gets a schema-valid result; an unexposed tool errors `-32601`; an unauthorized call errors via `authorize`.

**Commit 3 — `feat(mcp): exactly-once guard for mutating exposure + --audit + CF parity`**
- *Edit:* `mcpRouter.ts` — require a `session` + idempotency key for any `mcpExposed` tool that is mutating/flow-gated-class; **default-restrict** projection to read-only/`globalTools`-class tools (per `agentConfig.ts:32–37` — consequential tools stay flow-gated and OFF the MCP surface). A retrying JSON-RPC `tools/call` keys into the effect log → no double-execute.
- *New:* an `--audit` path (port hyper's `auditMcp`/`formatAuditHuman`, cli/mcp.ts) that dumps the exposed surface + inferred auth without serving — run before shipping any agent's MCP surface.
- *Edit:* `packages/kuralle-cf-agent/src/index.ts` — re-export the same projection for Cloudflare parity (CF is first-class; never deferred — standing rule).
- *Verify gate:* a retrying `tools/call` on a mutating tool executes **once** (effect-log assertion — the sharp edge); `--audit` lists exactly the flagged read-only tools; CF Worker exposes the same manifest as Node.

---

## Cross-cutting build notes
- **Stale dist gotcha:** after editing `kuralle-core/src` (heal Commits 2–3, MCP Commit 1), rebuild core before running anything in `kuralle-hono-server`/`cf-agent` that imports its `dist/`.
- **Run examples live, not just typecheck** — both ports need a live smoke (handoff-with-filter for heal; external MCP client for hyper), per the "untested example = broken example" rule.
- **Neutral cwd for `wrangler`/`npm`** — run CF/MCP smokes from repo root or `/tmp`, never inside a package dir (`config.load()` failure).
