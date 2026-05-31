/**
 * @module whatsapp/split
 *
 * Smart message splitting for WhatsApp's 4096-character limit.
 *
 * Splits long messages at natural boundaries (paragraph breaks, line breaks)
 * to maintain readability. Falls back to hard splitting only when no natural
 * boundary exists within the allowed range.
 */

/** Maximum character length for a single WhatsApp text message. */
const MAX_LENGTH = 4096;

/**
 * Split a text message into chunks that fit within WhatsApp's character limit.
 *
 * The splitting strategy prioritises readability:
 * 1. Paragraph boundaries (`\n\n`) within the first `maxLength` characters.
 * 2. Line boundaries (`\n`) if no paragraph break is available.
 * 3. Word boundaries (last space character) as a third preference.
 * 4. Hard split at `maxLength` as a last resort.
 *
 * A split point is only used if it falls in the latter half of the chunk
 * to avoid producing very short fragments.
 *
 * @param text      - The full message text.
 * @param maxLength - Maximum characters per chunk. Default `4096`.
 * @returns An array of text chunks, each within `maxLength`.
 *
 * @example
 * ```ts
 * const chunks = splitMessage(longReport);
 * for (const chunk of chunks) {
 *   await client.sendText(to, chunk);
 * }
 * ```
 */
export function splitMessage(text: string, maxLength: number = MAX_LENGTH): string[] {
  if (text.length <= maxLength) {
    return [text];
  }

  const chunks: string[] = [];
  let remaining = text;
  const minSplit = Math.floor(maxLength / 2);

  while (remaining.length > maxLength) {
    let splitIndex = -1;

    // 1. Try paragraph boundary (\n\n)
    splitIndex = remaining.lastIndexOf('\n\n', maxLength);
    if (splitIndex > 0 && splitIndex >= minSplit) {
      // Include the first newline as part of the chunk
      chunks.push(remaining.slice(0, splitIndex).trimEnd());
      remaining = remaining.slice(splitIndex + 2).trimStart();
      continue;
    }

    // 2. Try line boundary (\n)
    splitIndex = remaining.lastIndexOf('\n', maxLength);
    if (splitIndex > 0 && splitIndex >= minSplit) {
      chunks.push(remaining.slice(0, splitIndex).trimEnd());
      remaining = remaining.slice(splitIndex + 1).trimStart();
      continue;
    }

    // 3. Try word boundary (space)
    splitIndex = remaining.lastIndexOf(' ', maxLength);
    if (splitIndex > 0 && splitIndex >= minSplit) {
      chunks.push(remaining.slice(0, splitIndex).trimEnd());
      remaining = remaining.slice(splitIndex + 1).trimStart();
      continue;
    }

    // 4. Hard split at max length
    chunks.push(remaining.slice(0, maxLength));
    remaining = remaining.slice(maxLength);
  }

  if (remaining.length > 0) {
    chunks.push(remaining);
  }

  return chunks;
}
