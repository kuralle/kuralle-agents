/**
 * @module message-splitter
 *
 * Strategy-pattern abstraction over per-platform text-length limits.
 *
 * Each platform has its own way of chopping long outputs:
 * - WhatsApp — 4096 characters, split at paragraph/line/word boundaries.
 * - Messenger — 2000 characters, plain truncate at the boundary.
 * - Instagram — 1000 **UTF-8 bytes** (not characters; emojis / CJK spill).
 *
 * Instead of hand-coding these cutoffs inside each client, the client injects a
 * {@link MessageSplitter} implementation. Callers iterate the returned array
 * and send one message per chunk.
 */

/** Splits a string into one or more chunks fitting the platform's length limit. */
export interface MessageSplitter {
  split(text: string): string[];
}

// ---------------------------------------------------------------------------
// SmartSplitter (WhatsApp, 4096 chars)
// ---------------------------------------------------------------------------

/**
 * Greedy splitter that prefers paragraph > line > word boundaries, hard-splits
 * only when no boundary falls in the back half of the window. Equivalent to
 * the pre-migration `splitMessage()` helper in `whatsapp/split.ts`.
 */
export class SmartSplitter implements MessageSplitter {
  constructor(private readonly maxChars: number = 4096) {}

  split(text: string): string[] {
    if (text.length <= this.maxChars) return [text];

    const chunks: string[] = [];
    let remaining = text;
    const minSplit = Math.floor(this.maxChars / 2);

    while (remaining.length > this.maxChars) {
      let splitIndex = remaining.lastIndexOf('\n\n', this.maxChars);
      if (splitIndex > 0 && splitIndex >= minSplit) {
        chunks.push(remaining.slice(0, splitIndex).trimEnd());
        remaining = remaining.slice(splitIndex + 2).trimStart();
        continue;
      }

      splitIndex = remaining.lastIndexOf('\n', this.maxChars);
      if (splitIndex > 0 && splitIndex >= minSplit) {
        chunks.push(remaining.slice(0, splitIndex).trimEnd());
        remaining = remaining.slice(splitIndex + 1).trimStart();
        continue;
      }

      splitIndex = remaining.lastIndexOf(' ', this.maxChars);
      if (splitIndex > 0 && splitIndex >= minSplit) {
        chunks.push(remaining.slice(0, splitIndex).trimEnd());
        remaining = remaining.slice(splitIndex + 1).trimStart();
        continue;
      }

      chunks.push(remaining.slice(0, this.maxChars));
      remaining = remaining.slice(this.maxChars);
    }

    if (remaining.length > 0) chunks.push(remaining);
    return chunks;
  }
}

// ---------------------------------------------------------------------------
// TruncateSplitter (Messenger, 2000 chars)
// ---------------------------------------------------------------------------

/**
 * Truncates to a hard character limit. Used on Messenger where long turns are
 * rare enough that smart splitting wasn't worth the complexity at the old
 * client.
 */
export class TruncateSplitter implements MessageSplitter {
  constructor(private readonly maxChars: number = 2000) {}

  split(text: string): string[] {
    return text.length <= this.maxChars ? [text] : [text.slice(0, this.maxChars)];
  }
}

// ---------------------------------------------------------------------------
// ByteLimitSplitter (Instagram, 1000 UTF-8 bytes)
// ---------------------------------------------------------------------------

/**
 * Character-aware UTF-8 byte splitter for Instagram DMs.
 *
 * Instagram's 1000-byte ceiling is measured in UTF-8 bytes, not JS code
 * units. Emoji can be 4 bytes each; naive substring() splits tear grapheme
 * clusters. This splitter walks the string per-character, accumulates UTF-8
 * byte cost, and cuts at the last character that fits.
 */
export class ByteLimitSplitter implements MessageSplitter {
  private readonly encoder = new TextEncoder();

  constructor(private readonly maxBytes: number = 1000) {}

  split(text: string): string[] {
    if (this.encoder.encode(text).byteLength <= this.maxBytes) return [text];

    const chunks: string[] = [];
    let buf = '';
    let bufBytes = 0;

    // Iterate by full Unicode code points (handles surrogate pairs).
    for (const ch of text) {
      const chBytes = this.encoder.encode(ch).byteLength;
      if (bufBytes + chBytes > this.maxBytes) {
        if (buf.length > 0) {
          chunks.push(buf);
          buf = '';
          bufBytes = 0;
        }
        // Single character that exceeds the limit on its own (very rare — only
        // happens if `maxBytes` is pathologically small). Emit it alone.
        if (chBytes > this.maxBytes) {
          chunks.push(ch);
          continue;
        }
      }
      buf += ch;
      bufBytes += chBytes;
    }
    if (buf.length > 0) chunks.push(buf);
    return chunks;
  }
}
