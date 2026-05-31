/**
 * @module instagram/format
 *
 * Instagram-specific text format converter.
 *
 * Instagram DMs do not support any rich text formatting (no bold, italic,
 * strikethrough, etc.). All Markdown formatting is stripped and messages
 * are delivered as plain text.
 *
 * This converter handles bidirectional translation between Markdown and
 * plain text for the Instagram platform.
 */

import type { FormatConverter } from '@kuralle-agents/messaging';

/**
 * Converts text between Markdown and Instagram's plain text format.
 *
 * Instagram DMs are plain-text only, so `toPlatformFormat` strips all
 * Markdown formatting. `toMarkdown` passes text through unchanged since
 * Instagram messages are already plain text.
 *
 * @example
 * ```ts
 * const converter = new InstagramFormatConverter();
 *
 * // Markdown to Instagram (plain text)
 * converter.toPlatformFormat('**bold** and ~~strike~~');
 * // => 'bold and strike'
 *
 * // Instagram to Markdown (passthrough)
 * converter.toMarkdown('Hello world');
 * // => 'Hello world'
 * ```
 */
export class InstagramFormatConverter implements FormatConverter {
  /**
   * Convert standard Markdown to plain text for Instagram.
   *
   * Strips all Markdown formatting since Instagram DMs do not support
   * rich text rendering.
   *
   * @param markdown - Markdown-formatted text.
   * @returns Plain text with all formatting markers removed.
   */
  toPlatformFormat(markdown: string): string {
    return this.toPlainText(markdown);
  }

  /**
   * Convert Instagram text to Markdown.
   *
   * Instagram messages are plain text, so this is a passthrough.
   *
   * @param text - Plain text from Instagram.
   * @returns The same text unchanged.
   */
  toMarkdown(text: string): string {
    return text;
  }

  /**
   * Strip all Markdown formatting to produce plain text.
   *
   * @param markdown - Markdown-formatted text.
   * @returns Plain text with all formatting markers removed.
   */
  toPlainText(markdown: string): string {
    let text = markdown;

    // Remove code blocks but keep content
    text = text.replace(/```(?:\w*\n)?([\s\S]*?)```/g, '$1');

    // Remove inline code markers
    text = text.replace(/`([^`]+)`/g, '$1');

    // Remove heading markers
    text = text.replace(/^#{1,6}\s+/gm, '');

    // Remove images
    text = text.replace(/!\[([^\]]*)\]\([^)]+\)/g, '$1');

    // Remove links but keep text
    text = text.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1');

    // Remove bold (Markdown)
    text = text.replace(/\*\*(.+?)\*\*/g, '$1');
    text = text.replace(/(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)/g, '$1');

    // Remove italic
    text = text.replace(/__(.+?)__/g, '$1');
    text = text.replace(/(?<!_)_(?!_)(.+?)(?<!_)_(?!_)/g, '$1');

    // Remove strikethrough
    text = text.replace(/~~(.+?)~~/g, '$1');
    text = text.replace(/(?<!~)~(?!~)(.+?)(?<!~)~(?!~)/g, '$1');

    // Remove blockquote markers
    text = text.replace(/^>\s?/gm, '');

    // Remove horizontal rules
    text = text.replace(/^(?:---+|\*\*\*+|___+)\s*$/gm, '');

    return text.trim();
  }
}
