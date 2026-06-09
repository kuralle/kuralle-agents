# ADR 0009 — Multimodal intake (media → runtime)

**Status:** Accepted · **Date:** 2026-06-09 · **Builds on:** [ADR 0005 — AI-SDK-native UIMessage](./0005-ai-sdk-native-uimessage-default.md)

## Context

The runtime accepted only text. `RunOptions.input` was `string`, and `openRun` built the user turn as `{ role: 'user', content: input }` (a string). Every ingress collapsed rich input to text *before* it reached the runtime:

- **Web** — `extractInputFromBody` (hono-server) filtered UIMessage `parts` to `type === 'text'` and joined them; file parts were dropped.
- **Messaging** — `InboundResolverChain` / the engagement `resolveInbound` policies returned `m.text ?? ''` and never read `m.media`.

So a photo, a document, or a WhatsApp voice note arrived as an empty string. This blocks every vertical whose first input is an image or voice note (prescriptions, invoices, product pics, IDs).

The Vercel AI SDK — which we build on — already models this: a user `ModelMessage`'s `content` is `string | Array<TextPart | FilePart>`, and `streamText` sends file/image parts to the provider natively. The gap was purely that Kuralle narrowed to `string` at its own boundary.

## Decision

**Adopt the AI SDK's own user-content type end-to-end. No Kuralle media type.**

```ts
// runtime/userInput.ts
export type UserInputContent = UserContent; // string | Array<TextPart | ImagePart | FilePart>
```

- `RunOptions.input` and the messaging/web ingress are widened to `UserInputContent`. A plain string is still valid `UserContent`, so text-only callers are unchanged — but this is a **breaking type change** for anyone who declared `input: string` or implemented `ChannelPolicy.resolveInbound`.
- `openRun` passes the content straight into `{ role: 'user', content }` — zero translation, because the runtime already emits `ModelMessage`.
- The flow seam (`pending-input buffer`, `UserSignal.input`, `appendUserMessage`) carries `UserInputContent`. String-consuming sites (confirm-gate parsing, choice matching, extraction hints) use a `userInputToText()` projection that drops non-text parts.

### Durability invariant

`RunState.messages`, `session.messages`, and the pending-input buffer are all persisted through the `SessionStore` (JSON / Redis / Postgres). Therefore **`FilePart.data` must be JSON-serializable** — a base64 string, a `data:` URL, or an `https` URL — **never a raw `Buffer`/`Uint8Array`**. The messaging ingress base64-encodes downloaded bytes for exactly this reason.

### Where media is resolved

- **Web** — `partsToUserInput` maps UIMessage parts to content: text → `TextPart`, `{type:'file', url, mediaType}` → `FilePart{ data: url }`. Text-only input collapses back to a plain string (so text flows are byte-identical). This is the ai-chatbot upload shape (blob URL + mediaType).
- **Messaging** — media download needs the platform client (WhatsApp sends a media *id*, not bytes), which lives at the **router**, not in the client-less policy `resolveInbound`. So `createMessagingRouter` runs `attachInboundMedia(message, resolvedInput, platform)` after the resolver chain: it downloads via `platform.downloadMedia(id)` (or passes a hosted `url` through), base64-encodes, and attaches a `FilePart` plus the caption as a leading `TextPart`. This is channel-agnostic and works whether or not the engagement policy layer is in use.

### Audio / voice notes

Audio is handled explicitly, not by guessing model capability:

- `HarnessConfig.transcriptionModel?: TranscriptionModel` (AI SDK). When set, `transcribeAudioParts` (called in `openRun`) replaces each audio `FilePart` with its transcript as a `TextPart` — so voice notes work on **text-only** models.
- When **no** `transcriptionModel` is configured, audio parts pass through unchanged to audio-capable models (e.g. Gemini), which accept them directly.

`transcribeAudioParts` normalizes the audio source for `transcribe`: a bare string is treated as base64, so `data:` URLs are reduced to their base64 payload and `http(s)` URLs become a `URL` (fetched by the built-in download).

### What we are NOT doing, and why

- **No Kuralle-specific media/attachment type.** We are AI-SDK-native (ADR 0005); inventing `KuralleMedia` would mean a translation layer on every turn. `UserContent` *is* the type the model consumes.
- **No `Buffer` in `FilePart.data` on the runtime path.** It would corrupt the durable session store. Base64/URL only.
- **No media on the legacy `/api/flow/*` string-only endpoints.** Their `flowManager.process(input: string)` is a different, narrower subsystem; media degrades to its text projection there (a capability limit, not a shim).
- **No model-capability sniffing for audio.** `transcriptionModel` set ⇒ transcribe; unset ⇒ pass through. Explicit and testable.

## Consequences

- Photos, documents, and voice notes now reach the model on both the web (`/api/chat/*`) and messaging ingress paths.
- **Breaking:** `RunOptions.input: string → UserInputContent`; `ChannelPolicy.resolveInbound` / `InboundResolverPlugin` return `{ input: UserInputContent }`. See [`MIGRATION.md`](../../MIGRATION.md).
- New exports from `@kuralle-agents/core`: `UserInputContent`, `userInputToText`, `hasMediaParts`, `transcribeAudioParts`. New export from `@kuralle-agents/messaging`: `attachInboundMedia`.
- Verified: full graph build green; `multimodal-input.test.ts` (core), `inbound-media.test.ts` (messaging), and a live offline smoke (`examples/multimodal-intake-smoke.ts`) prove image-reaches-model and voice-note-transcribed end-to-end.
