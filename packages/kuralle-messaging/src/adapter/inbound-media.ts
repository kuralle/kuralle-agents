import type { UserInputContent } from '@kuralle-agents/core';
import type { InboundMessage } from '../types/messages.js';
import type { PlatformClient } from '../types/client.js';

/** Fallback media type when the platform omits a MIME type, keyed by message kind. */
function fallbackMediaType(type: InboundMessage['type']): string {
  switch (type) {
    case 'image':
      return 'image/jpeg';
    case 'audio':
      return 'audio/ogg';
    case 'video':
      return 'video/mp4';
    case 'sticker':
      return 'image/webp';
    default:
      return 'application/octet-stream';
  }
}

/**
 * Attach inbound media (image / audio / video / document / sticker) to the user
 * turn as an AI SDK file part, so it reaches the model instead of being dropped.
 *
 * Bytes are downloaded via the platform client and base64-encoded — the durable
 * runtime persists the user message through the session store (JSON/Redis/Postgres),
 * so a raw `Buffer` is not safe; a base64 string is. When the platform already
 * exposes a hosted URL on the reference, that URL is passed through instead.
 *
 * The caption (or any text the resolver produced) becomes a leading text part, so
 * "here's my prescription 📷 + can you read it?" arrives as one multimodal turn.
 * Non-media messages return `textInput` unchanged.
 */
export async function attachInboundMedia(
  message: InboundMessage,
  textInput: UserInputContent,
  client: Pick<PlatformClient, 'downloadMedia'>,
): Promise<UserInputContent> {
  const ref = message.media;
  if (!ref) return textInput;

  const caption = ref.caption ?? (typeof textInput === 'string' ? textInput : '');

  let data: string;
  let mediaType: string;
  if (ref.url) {
    data = ref.url;
    mediaType = ref.mimeType || fallbackMediaType(message.type);
  } else {
    const download = await client.downloadMedia(ref.id);
    data = download.data.toString('base64');
    mediaType = ref.mimeType || download.mimeType || fallbackMediaType(message.type);
  }

  const parts: Exclude<UserInputContent, string> = [];
  if (caption.trim()) parts.push({ type: 'text', text: caption });
  parts.push({ type: 'file', data, mediaType, filename: ref.filename });
  return parts;
}
