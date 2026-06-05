# native-c1 implementation notes

## Decisions

- `harnessToUIMessageStream` uses `createUIMessageStream<KuralleUIMessage>` with a typed `UIMessageStreamWriter` so all `data-kuralle-*` parts are compile-time checked against `KuralleDataParts`.
- Harness `{ type: 'error' }` throws inside `execute`; AI SDK v6.0.193 catches async execute failures and emits `{ type: 'error', errorText }` rather than rejecting the `ReadableStream`. Tests assert the error chunk shape.
- `text-cancel` maps to `text-end` (no native cancel chunk in AI SDK v6).
- `opts.sessionId` is accepted but unused in C1 — reserved for C2 message metadata wiring.

## Verified against

- `ai@6.0.193` types: `UIMessageChunk` includes `text-start/delta/end`, `tool-input-available`, `tool-output-available`, and `data-${NAME}` with optional `transient`.
