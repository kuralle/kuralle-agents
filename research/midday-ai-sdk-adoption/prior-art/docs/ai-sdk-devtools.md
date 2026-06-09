# ai-sdk-devtools (`@ai-sdk-tools/devtools`) — firsthand inspection

Inspected at: `research/midday-ai-sdk-adoption/prior-art/clones/ai-sdk-tools/packages/devtools`
Repo: `github.com/midday-ai/ai-sdk-tools` (monorepo, the `devtools` package)
Repo HEAD: `a1cc555 2025-11-21 v1.2.0`

## License (verified)

- `package.json` declares `"license": "MIT"` (author: Pontus Abrahamsson) — verbatim at `packages/devtools/package.json`.
- **No actual `LICENSE` file exists.** The package's `files` array lists `"LICENSE"` but no such file is present in the package dir, and there is **no root `LICENSE` either** (`find . -iname "license*"` returns nothing; root `package.json` has no `license` field). So the license is MIT *by declaration only* — the text file the publish manifest references is missing. Usable as MIT, but the canonical license text is absent from the source tree.

## Maintenance signals

- **Version:** `1.2.0` in `package.json`. (Note: the package `CHANGELOG.md` header is internally inconsistent — top entry reads `## 2.0.0` / "Release version 1.2.0", a changeset-versioning artifact.)
- **Recency:** last commit touching `packages/devtools` is the repo HEAD, `2025-11-21`. Actively maintained as of inspection.
- **Tests:** **none.** No `*.test.*` / `*.spec.*` anywhere in `packages/devtools` *or the whole monorepo* (`find` over the repo returns zero test files). No test script in `package.json` — only `build` (tsup), `dev`, `clean`, `type-check` (`tsc --noEmit`). Quality gate is typecheck + biome lint only.
- **Build:** tsup, dual `cjs`+`esm`, `dts` enabled, `treeshake: true` (`tsup.config.ts`).
- **Size:** 22 source files, ~4,400 LOC. Heaviest: `devtools-panel.tsx` (809), `event-parser.ts` (780), `agent-flow-visualization.tsx` (545).
- **Heavy runtime deps:** MUI (`@mui/material`, `@mui/icons-material`), Emotion, `@xyflow/react` + `dagre` (the agent-flow graph), `react-json-view-lite`. This is a heavyweight UI bundle, not a thin widget.

## AI-SDK-native?

**Yes, but loosely coupled — it consumes the AI SDK *wire protocol*, not the SDK runtime.**

- Declares `ai: ^5.0.82` as a dependency and `@ai-sdk/react: >=2.0.0` as a peer dep (`package.json`).
- The **only** type import from `ai` is `LanguageModelUsage` (`src/types/index.ts:1`) — and it is used only to type-annotate the `data` field; nothing calls into the SDK.
- It does **not** wrap `useChat`, does not import a transport, does not take an AI SDK chat handle. It never touches the SDK's runtime objects. Coupling is to the **AI SDK Data Stream Protocol on the wire** (the `text-delta` / `tool-call` / `tool-result` / `finish` SSE part shapes), parsed by hand in `event-parser.ts`.
- Optional second integration: `@ai-sdk-tools/store` (this repo's own Zustand-based `useChat` replacement) for the live state-inspection panel — an **optional peer dep** (`peerDependenciesMeta.@ai-sdk-tools/store.optional = true`).

## Event source: what it consumes

The event source is **a monkey-patched global `window.fetch`** that tees the HTTP response stream. It is *not* fed by an AI SDK hook, callback, or event emitter.

`StreamInterceptor` (`src/utils/stream-interceptor.ts`):
- On `patch()`, replaces `window.fetch` with a wrapper (`stream-interceptor.ts:156`).
- For URLs matching configured `endpoints` (default `["/api/chat"]`, substring match — `shouldInterceptUrl`, line 31) and a `content-type` of `text/event-stream` or `text/plain`, it tees the `ReadableStream`: enqueues the original chunk to the consumer **first** (so the real `useChat`/app stream is never blocked or delayed — `stream-interceptor.ts:67-69`), then decodes a copy and parses it.
- `parseSSEChunk` (line 102) splits on `\n`, accumulates `event:` / `data:` lines, and on each complete SSE record calls `parseSSEEvent`.
- `parseSSEEvent` → `parseEventFromDataPart` (`event-parser.ts`) maps AI SDK Data Stream part `type`s (`text-delta`, `text-done`, `tool-call`, `tool-result`, `tool-input-start/delta`, `data`, `error`, `finish`, plus a whole agent-orchestration family) onto the package's normalized `AIEvent` union. Also handles `[DONE]`.

Consequence: it is **transport-coupled to fetch+SSE**, but **framework-agnostic above that** — any backend that emits AI-SDK-shaped SSE over `fetch` is observable, regardless of whether the frontend uses `@ai-sdk/react`, this repo's `store`, or raw fetch. WebSocket / non-fetch transports are *not* covered.

## Core mechanism

1. **Capture** — `useAIDevtools` (`hooks/use-ai-devtools.ts`) instantiates one `StreamInterceptor` in a `useEffect`, patches `fetch`, and pushes normalized `AIEvent`s into React state. It enforces `maxEvents` (default 1000, ring-buffer via `slice(-maxEvents)`) and **throttling** keyed by `type_messageId` (default: only `text-delta` is throttled at 100ms — `ai-dev-tools.tsx:26-30`) to avoid re-render storms during streaming.
2. **Normalize** — `event-parser.ts` is the load-bearing translation layer from raw SSE/JSON parts to the discriminated `AIEvent` (id, timestamp, type, data, metadata{toolName, toolCallId, agent, round, fromAgent/toAgent, …}).
3. **Derive views** — pure utils on the event array: `session-grouper.ts` groups tool-call start/result/error into `ToolCallSession`s; `agent-flow-visualization.tsx` builds a dagre-laid-out `@xyflow/react` graph of agents/tools/handoffs.
4. **Metrics** — tokens/sec is **estimated**, not read from `usage`: `devtools-panel.tsx:284` filters last-60s `text-delta` events, sums `delta`/`text` char length, divides by 4 ("1 token ≈ 4 characters" heuristic), divides by elapsed seconds. So "tokens/sec" is a character-derived approximation, not provider usage data.
5. **State inspection** — `useCurrentState` (`hooks/use-current-state.ts`) reads the optional `@ai-sdk-tools/store` Zustand store via `ChatStoreContext`, `subscribe`s to it, and mirrors `getState()` into the panel. Gracefully degrades when the store isn't installed (`isStorePackageAvailable` does a `try{require()}` probe).
6. **Filtering** — `filterEvents(filterTypes?, searchQuery?, toolNames?)` does type-set membership + tool-name membership + full-text `JSON.stringify(data/metadata).includes(query)` (react-query-devtools-style live filter — `use-ai-devtools.ts:165`).

## Transport-agnostic core vs React shell

There is a **clear separation**, though it is not packaged as a standalone core:

- **Framework-free layer** (plain TS, no React): `utils/stream-interceptor.ts`, `utils/event-parser.ts`, `utils/session-grouper.ts`, `types/`. These are exported individually (`StreamInterceptor`, `parseSSEEvent`, `parseEventFromDataPart`, `groupEventsIntoSessions`, formatting helpers) from `index.ts:35-54`, so the capture+normalize engine is reusable outside React.
- **React shell**: the `useAIDevtools` hook (state mgmt, throttle, lifecycle) + the MUI/xyflow components (`AIDevtools`, `DevtoolsPanel`, `AgentFlowVisualization`, etc.).
- **Caveat on "transport-agnostic":** the engine is agnostic to *frontend framework* and *backend framework*, but **hard-wired to `window.fetch` + SSE**. It assumes a browser global `fetch`, a streaming response, and AI-SDK-shaped SSE parts. There is no transport abstraction/interface — swapping in WebSocket or a Node environment would require replacing `StreamInterceptor` wholesale. The "core" is `fetch`-transport-specific, not transport-pluggable.

## API surface (real signatures)

From `src/index.ts` and `src/types/index.ts`:

```ts
// Primary component
function AIDevtools(props: UseAIDevtoolsOptions & {
  config?: Partial<DevtoolsConfig>;
  className?: string;
  debug?: boolean;
}): JSX.Element | null

// Hooks
function useAIDevtools(options?: UseAIDevtoolsOptions): UseAIDevtoolsReturn
function useCurrentState(options?: { enabled?: boolean }): {
  isStoreAvailable: boolean;
  availableStoreIds: string[];
  currentStates: Record<string, unknown>;
  refreshStates: () => void;
}

interface UseAIDevtoolsOptions {
  enabled?: boolean;
  maxEvents?: number;                 // default 1000
  onEvent?: (event: AIEvent) => void;
  modelId?: string;
  debug?: boolean;
  streamCapture?: { enabled?: boolean; endpoints?: string[]; autoConnect?: boolean };
  throttle?: { enabled?: boolean; interval?: number; excludeTypes?: AIEventType[]; includeTypes?: AIEventType[] };
}

interface UseAIDevtoolsReturn {
  events: AIEvent[];
  isCapturing: boolean;
  clearEvents(): void;
  toggleCapturing(): void;
  filterEvents(types?: AIEventType[], searchQuery?: string, toolNames?: string[]): AIEvent[];
  getUniqueToolNames(): string[];
  getEventStats(): { total: number; byType: Record<AIEventType, number>; byTool: Record<string, number>; timeRange: {start:number;end:number} | null };
}

interface AIEvent {
  id: string; timestamp: number; type: AIEventType;
  data: any & { usage: LanguageModelUsage };
  metadata?: { toolName?; toolCallId?; toolParams?; duration?; messageId?;
               agent?; round?; fromAgent?; toAgent?; reason?;
               routingStrategy?: "programmatic" | "llm"; matchScore?; [k:string]: any };
}

// Framework-free engine (exported)
class StreamInterceptor {
  constructor(options: { onEvent:(e:AIEvent)=>void; endpoints:string[]; enabled:boolean; debug?:boolean });
  patch(): void; unpatch(): void;
  updateOptions(o: Partial<StreamInterceptorOptions>): void; isActive(): boolean;
}
function parseSSEEvent(eventData: string, eventType: string, eventId: string): AIEvent | null
function parseEventFromDataPart(dataPart: any, eventId: string): AIEvent | null
function groupEventsIntoSessions(events: AIEvent[]): ToolCallSession[]
function isStorePackageAvailable(): boolean
```

`AIEventType` is a 30-member union: AI SDK stream lifecycle (`text-start/-delta/-end`, `reasoning-*`, `start/-step`, `finish/-step`, `tool-call-*`) **plus a first-class agent-orchestration family** (`agent-start/-step/-finish/-handoff/-complete/-error`) — i.e. devtools is purpose-built to also visualize this repo's own multi-agent runtime, not just plain chat.

## Verbatim source snippets

`src/utils/stream-interceptor.ts:67-73` — the tee that keeps the original stream unblocked:
```ts
              // CRITICAL: Pass the original chunk through FIRST
              // This ensures the original stream is never blocked
              controller.enqueue(value);

              try {
                const chunk = decoder.decode(value, { stream: true });
                this.parseSSEChunk(chunk);
```

`src/utils/stream-interceptor.ts:156-168` — fetch monkey-patch is the event source:
```ts
    (window.fetch as any) = async (
      input: RequestInfo | URL,
      init?: RequestInit,
    ): Promise<Response> => {
      const url = typeof input === "string" ? input : input.toString();
      // Safety: Skip interception if we've had errors
      if (this.hasErrors) {
        return this.originalFetch(input, init);
      }
      // Check if this is a request we should intercept
      if (this.shouldInterceptUrl(url)) {
```

`src/types/index.ts:1` + `:38` — the entire `ai` SDK coupling is one type import:
```ts
import type { LanguageModelUsage } from "ai";
...
  data: any & { usage: LanguageModelUsage }; // Use AI SDK stream part types
```

`src/components/devtools-panel.tsx:304-326` — tokens/sec is a char/4 estimate, not provider usage:
```ts
    // Estimate tokens (common heuristic: 1 token ≈ 4 characters)
    const totalTokens = Math.round(totalCharacters / 4);
...
    return {
      tokensPerSecond: Number.parseFloat(
        (totalTokens / durationSeconds).toFixed(2),
      ),
```

`src/hooks/use-current-state.ts:54-69` — optional Zustand store inspection, degrades silently:
```ts
  const isStoreAvailable = storeApi !== undefined && storeApi !== null;
  const availableStoreIds = isStoreAvailable ? ["default"] : [];
  const refreshStates = useCallback(() => {
    if (!storeApi || !isStoreAvailable) return;
    try {
      const state = storeApi.getState();
      setCurrentStates({ default: state });
    } catch { /* Failed to get state */ }
  }, [storeApi, isStoreAvailable]);
```

## Relevance to AriaFlow / Kuralle

- The `fetch`-tee + SSE-part parser is exactly the pattern a Kuralle "devtools" would need to observe `/api/chat` traffic **without touching the runtime** — and it tolerates Kuralle's native AI-SDK `UIMessageStream` (0.5.0) since it parses the same wire parts. But it assumes browser `fetch`; it would not see Cloudflare DO / WebSocket transports without a new interceptor.
- The agent-orchestration event family + dagre graph is a strong reference for visualizing flow/handoff topology, but it is tightly bound to this repo's own agent event naming.
- Heavy MUI/xyflow dependency footprint and **zero tests** are adoption risks if vendored.
