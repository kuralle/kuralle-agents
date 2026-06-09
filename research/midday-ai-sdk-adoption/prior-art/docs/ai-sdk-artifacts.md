# Firsthand inspection: `@ai-sdk-tools/artifacts`

Inspected from source clone at
`research/midday-ai-sdk-adoption/prior-art/clones/ai-sdk-tools/packages/artifacts`.
Focus: `artifact.stream()` inside a tool `execute` → type-safe structured streaming to React components (generative UI), and the writer/context plumbing.

## License (verified)

- `package.json` → `"license": "MIT"` (verified by reading the file, line: `"license": "MIT"`).
- **No `LICENSE` file exists** in the package dir, and **no `LICENSE` file at the repo root** (`ls LICENSE*` at repo root → "no matches"; the package `package.json` `files` array lists `"LICENSE"` but the file is absent in this clone). Root `package.json` has no `license` field.
- Net: declared MIT in package metadata; no LICENSE text file shipped/cloned. License is MIT per the package manifest only.

## Package identity / maintenance signals

- Name: `@ai-sdk-tools/artifacts`, version **`1.2.0`** (package.json). Author: Pontus Abrahamsson (midday-ai).
- Repo: `github.com/midday-ai/ai-sdk-tools`. Part of a Bun/biome monorepo (sibling packages: `@ai-sdk-tools/store`, used by the client hooks).
- Last-touched: this clone is shallow/squashed — `git log` for the package shows a single commit `a1cc555 2025-11-21 v1.2.0`. So the only recency signal is the **2025-11-21** tag commit. (CHANGELOG.md is itself inconsistent: top heading says `## 2.0.0` while the note text says "Release version 1.2.0" — the changelog generation is sloppy.)
- **Tests: none.** No `*.test.*` / `*.spec.*` anywhere in the package. Verification is by example scripts only.
- **Examples are stale / do not match the shipped source** (see "Discrepancies" below) — a real correctness smell.
- Source is small: 7 `src/*.ts(x)` modules; `hooks.ts` is the largest at 761 lines (client consumption + version/dismiss logic). The server-side streaming core is ~150 lines total across `artifact.ts` + `streaming.ts` + `context.ts` + `types.ts`.

## AI-SDK-native?

**Yes, hard dependency on the Vercel AI SDK.**

- `peerDependencies`: `"ai": "^5.0.82"`, `"react": "^18 || ^19"`. Runtime dep: `zod ^4.1.12`.
- Server core imports the AI SDK directly:
  - `import type { UIMessageStreamWriter } from "ai";` in `artifact.ts:1`, `streaming.ts:1`, `context.ts:9`.
  - `import { generateId as generateIdAi } from "ai";` in `utils.ts:1`.
- The whole streaming contract is the AI SDK's `UIMessageStreamWriter` + custom **data parts** (`type: "data-artifact-<id>"`), consumed on the client as AI SDK `UIMessage.parts`. The writer is obtained from the AI SDK tool `execute`'s `experimental_context`.
- Client hooks import `UIMessage` from `@ai-sdk/react` and read messages via `@ai-sdk-tools/store` (a drop-in AI SDK chat store).

## API surface (real signatures, from src)

### Server / shared (`src/index.ts` exports — server-safe, no React)

```ts
// artifact.ts
export function artifact<T>(id: string, schema: z.ZodSchema<T>): {
  id: string;
  schema: z.ZodSchema<T>;
  create(data?: Partial<T>): ArtifactData<T>;
  stream(data: Partial<T>, writer: UIMessageStreamWriter): StreamingArtifact<T>;
  validate(data: unknown): T;
  isValid(data: unknown): data is T;
};

// context.ts
export function getWriter(executionOptions?: any): UIMessageStreamWriter;

// streaming.ts
export class StreamingArtifact<T> {
  get data(): T;
  get id(): string;
  get progress(): number | undefined;
  set progress(value: number | undefined);          // setter re-streams
  update(updates: Partial<T> & { progress?: number }): Promise<void>;
  complete(finalData?: T): Promise<void>;
  error(message: string): Promise<void>;
  cancel(): Promise<void>;
  timeout(ms: number): void;
}

// types.ts
export class ArtifactError extends Error { constructor(code: string, message: string); }
export interface ArtifactData<T> {
  id; type; status: ArtifactStatus; payload: T; version: number;
  progress?: number; error?: string; createdAt: number; updatedAt: number;
}
export type ArtifactStatus = "idle" | "loading" | "streaming" | "complete" | "error";
```

### Client (`src/client.ts` exports — adds React hooks)

```ts
// hooks.ts
export function useArtifact<T extends { id: string; schema: z.ZodSchema<unknown> }>(
  artifactDef: T,
  options?: UseArtifactOptions<InferArtifactType<T>>,
): [UseArtifactReturn<InferArtifactType<T>>, UseArtifactActions];

export function useArtifacts(/* options */): [UseArtifactsReturn, UseArtifactsActions];
```

`useArtifact` returns `{ data, status, progress, error, isActive, hasData, versions, currentIndex }` plus a `{ delete }` action, and fires `onUpdate/onComplete/onError/onProgress/onStatusChange` callbacks.

## Core mechanism (how it actually works, from reading src)

1. **Definition.** `artifact(id, zodSchema)` returns a small object carrying `id` + `schema` and four helpers. `create()` seeds an `ArtifactData<T>` envelope: zod-validated payload (`schema.parse({ ...getDefaults(schema), ...data })`), `status: "idle"`, `version: 1`, timestamps, and a generated id (`artifact_<ts>_<aiSdkId>`). `getDefaults` is a hack: `schema.parse({})` and swallow on throw — so default extraction only works if every field has a zod `.default()` (the burn-rate example deliberately defaults everything).

2. **Start streaming inside a tool.** `artifact.stream(data, writer)` → `create()`, flips status to `"loading"`, and constructs a `StreamingArtifact`, whose **constructor immediately calls `this.stream()` to emit the initial state**. So merely calling `.stream(...)` writes the first frame.

3. **The wire frame.** Every state push is one AI SDK custom data part written to the `UIMessageStreamWriter`:

   ```ts
   this.writer.write({
     type: `data-artifact-${this.config.id}`,
     id: this.instance.id,
     data: this.instance,        // the full ArtifactData<T> envelope, every time
   });
   ```

   It is **full-snapshot, not a delta** — the entire envelope (payload + status + version + progress) is re-sent on every `update/progress/complete/error`. `version` increments monotonically; the client uses `version` (tie-broken by `createdAt`) to decide "newer".

4. **Mutation surface.** `update(partial)` shallow-merges into `payload`, sets status `"streaming"`, bumps `version`, re-streams. `progress` is a **setter** that re-streams on assignment. `complete(final?)` sets status `complete` + `progress: 1`. `error(msg)` / `cancel()` set status `error`. `timeout(ms)` schedules a `setTimeout` that errors the artifact if it's still loading/streaming. All mutators are `async` but do no awaiting internally — the `async` is cosmetic (writes are synchronous to the writer).

5. **Writer plumbing — how `execute` gets a writer.** The AI SDK does not hand a writer to `tool.execute` natively. The route opens an AI SDK `createUIMessageStream({ execute: ({ writer }) => { ... } })`, runs `streamText({ tools })` inside, and `writer.merge(result.toUIMessageStream())`. To reach the writer *inside a tool*, the writer is stashed on `streamText`'s `experimental_context`, and the tool reads it via `getWriter(executionOptions)`:

   ```ts
   // context.ts
   export function getWriter(executionOptions?: any): UIMessageStreamWriter {
     const writer = executionOptions?.experimental_context?.writer; // AI SDK context
     if (!writer) throw new Error("Writer not available...");
     return writer;
   }
   ```

   That is the entire "context" coupling — there is no DI container, just `experimental_context.writer`. `executionOptions` is typed `any` (no type safety on the writer retrieval).

6. **Client consumption.** `useArtifact(def)` pulls `messages` from `@ai-sdk-tools/store`, scans each message's `parts` for `part.type === "data-artifact-<def.id>"`, extracts the embedded `ArtifactData`, and tracks the latest by `version`/`createdAt`. State diffs drive the typed callbacks. The Zod schema gives `InferArtifactType<T>` so `data` is fully typed at the React component boundary — that is the "type-safe structured streaming to React" claim. `delete` rewrites the owning message via the store's `replaceMessageById`, also reaching into `tool-*` result parts that may nest artifacts.

## Discrepancies found (firsthand — examples vs shipped source)

These are real and would bite an adopter:

- **`createTypedContext` / `BaseContext` / `setContext` / `getContext` do not exist in the shipped source.** Both `src/examples/typed-context-example.ts` and the package `README.md` (§3) import `createTypedContext` and `BaseContext` from `@ai-sdk-tools/artifacts`, but `grep` across `src/` finds these symbols **only in the examples** — `context.ts` exports `getWriter` only, and `types.ts` has no `BaseContext`. The README's headline "typed context" DX is not implemented in `1.2.0`'s source. The real, shipped path is `getWriter(executionOptions)`.
- **`BurnRate.stream(data)` called with one argument** in `src/examples/burn-rate-example.ts:71` and README §2, but the shipped signature is `stream(data, writer)` (writer required; `StreamingArtifact` ctor dereferences it immediately). The examples would throw at runtime ("Cannot read properties of undefined").

Net: the streaming core (`artifact`/`StreamingArtifact`/`getWriter`) is coherent and small, but the published examples/README are out of sync with the shipped 1.2.0 source and there are zero tests guarding any of it.

## Verbatim source snippets (load-bearing)

`src/artifact.ts:29-36` — the `stream()` entry that creates a `StreamingArtifact`:
```ts
    stream(
      data: Partial<T>,
      writer: UIMessageStreamWriter,
    ): StreamingArtifact<T> {
      const instance = this.create(data);
      instance.status = "loading";
      return new StreamingArtifact(config, instance, writer);
    },
```

`src/streaming.ts:91-97` — the single wire-write (full-snapshot AI SDK data part):
```ts
  private stream(): void {
    this.writer.write({
      type: `data-artifact-${this.config.id}`,
      id: this.instance.id,
      data: this.instance,
    });
  }
```

`src/context.ts:27-37` — writer plumbing via AI SDK `experimental_context`:
```ts
export function getWriter(executionOptions?: any): UIMessageStreamWriter {
  // AI SDK passes context via experimental_context
  const writer = executionOptions?.experimental_context?.writer;

  if (!writer) {
    throw new Error(
      "Writer not available. Make sure you're passing executionOptions: getWriter(executionOptions)",
    );
  }

  return writer;
}
```

`src/streaming.ts:40-51` — `update()` merge + version bump that drives re-render:
```ts
  async update(updates: Partial<T> & { progress?: number }): Promise<void> {
    if ("progress" in updates) {
      this.instance.progress = updates.progress;
      delete (updates as Record<string, unknown>).progress; // Remove progress from payload updates
    }

    this.instance.payload = { ...this.instance.payload, ...updates };
    this.instance.status = "streaming";
    this.instance.version++;
    this.instance.updatedAt = Date.now();
    this.stream();
  }
```

`src/types.ts:37-41` — the typed wire part contract (custom AI SDK data part):
```ts
export interface ArtifactStreamPart<T = unknown> {
  type: `data-artifact-${string}`;
  id: string;
  data: ArtifactData<T>;
}
```
