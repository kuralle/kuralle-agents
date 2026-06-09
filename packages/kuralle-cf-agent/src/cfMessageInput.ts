import type { UserInputContent } from '@kuralle-agents/core';
import type { UIMessage } from 'ai';

/**
 * Map the last user turn in a CF `UIMessage[]` to runtime `UserInputContent`.
 *
 * Text parts → `TextPart`; file parts (images / documents / audio uploaded via the
 * CF chat client) → `FilePart` carrying the part's URL, so multimodal input reaches
 * the model instead of being dropped. A text-only turn collapses to a plain string.
 * Returns `null` when the last user turn carries no usable content.
 */
export function lastUserInputFromMessages(messages: UIMessage[]): UserInputContent | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (!msg || msg.role !== 'user') continue;

    const content: Exclude<UserInputContent, string> = [];
    for (const part of msg.parts ?? []) {
      if (part.type === 'text' && typeof part.text === 'string') {
        content.push({ type: 'text', text: part.text });
      } else if (
        part.type === 'file' &&
        typeof part.url === 'string' &&
        typeof part.mediaType === 'string'
      ) {
        content.push({
          type: 'file',
          data: part.url,
          mediaType: part.mediaType,
          filename: part.filename,
        });
      }
    }

    if (content.length === 0) continue;
    const hasFile = content.some((p) => p.type === 'file');
    if (!hasFile) {
      const text = content.map((p) => (p.type === 'text' ? p.text : '')).join('');
      if (text.trim()) return text;
      continue;
    }
    return content;
  }
  return null;
}
