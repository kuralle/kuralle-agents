import {
  experimental_transcribe as transcribe,
  type UserContent,
  type TranscriptionModel,
  type FilePart,
  type TextPart,
} from 'ai';

/**
 * User-turn content the runtime accepts: plain text, or AI SDK multimodal parts
 * (text + file/image/audio). This is exactly the `content` of a user `ModelMessage`,
 * so it threads into the model with no translation.
 *
 * Durability invariant: any `FilePart.data` flowing through the runtime must be
 * JSON-serializable (a base64 string, data URL, or https URL) — never a raw
 * `Buffer`/`Uint8Array`. `RunState.messages`, `session.messages`, and the pending
 * input buffer are all persisted through the `SessionStore` (JSON/Redis/Postgres).
 */
export type UserInputContent = UserContent;

/** One part of multimodal user content: `TextPart | ImagePart | FilePart`. */
type UserContentPart = Exclude<UserContent, string>[number];

function isFilePart(part: UserContentPart): part is FilePart {
  return part.type === 'file';
}

function isAudioPart(part: FilePart): boolean {
  return typeof part.mediaType === 'string' && part.mediaType.startsWith('audio/');
}

/**
 * Normalize a FilePart's `data` into something AI SDK `transcribe` accepts as
 * `audio`. A bare string is treated by `transcribe` as base64, so http(s) URLs
 * must become a `URL` (fetched via the built-in download) and `data:` URLs must
 * be reduced to their base64 payload. Bytes and `URL`s pass through unchanged.
 */
function audioSource(data: FilePart['data']): FilePart['data'] {
  if (typeof data !== 'string') return data;
  if (data.startsWith('data:')) {
    const comma = data.indexOf(',');
    return comma === -1 ? data : data.slice(comma + 1);
  }
  if (data.startsWith('http://') || data.startsWith('https://')) {
    return new URL(data);
  }
  return data;
}

/** Merge multiple user inputs into one turn (ingress coalescing / mid-turn drain). */
export function mergeUserInputContents(items: UserInputContent[]): UserInputContent | undefined {
  if (items.length === 0) return undefined;
  if (items.length === 1) return items[0];

  const parts: UserContentPart[] = [];
  for (const item of items) {
    if (typeof item === 'string') {
      if (item.length > 0) parts.push({ type: 'text', text: item });
    } else {
      parts.push(...item);
    }
  }
  if (parts.length === 0) return '';
  return parts;
}

/** Text projection of user input — for confirm-gate parsing, choice matching, and
 *  extraction hints. Non-text parts are dropped. A plain string returns as-is. */
export function userInputToText(input: UserInputContent): string {
  if (typeof input === 'string') return input;
  return input
    .filter((p): p is TextPart => p.type === 'text')
    .map((p) => p.text)
    .join(' ')
    .trim();
}

/** Whether the input carries any non-text (file/image/audio) parts. */
export function hasMediaParts(input: UserInputContent): boolean {
  return typeof input !== 'string' && input.some((p) => p.type !== 'text');
}

/**
 * Replace audio file parts with their transcript (a text part) using an AI SDK
 * transcription model. With no model configured, audio parts pass through
 * unchanged — audio-capable models (e.g. Gemini) accept them directly. Non-audio
 * parts (images, documents) are always left untouched.
 */
export async function transcribeAudioParts(
  input: UserInputContent,
  transcriptionModel: TranscriptionModel | undefined,
): Promise<UserInputContent> {
  if (!transcriptionModel || typeof input === 'string') return input;
  if (!input.some((p) => isFilePart(p) && isAudioPart(p))) return input;

  const out: UserContentPart[] = [];
  for (const part of input) {
    if (isFilePart(part) && isAudioPart(part)) {
      const { text } = await transcribe({
        model: transcriptionModel,
        audio: audioSource(part.data),
      });
      if (text.trim()) out.push({ type: 'text', text });
    } else {
      out.push(part);
    }
  }
  return out;
}
