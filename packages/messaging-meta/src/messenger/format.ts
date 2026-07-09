/**
 * @module messenger/format
 *
 * Messenger-specific text format converter.
 *
 * Facebook Messenger does not support any native text formatting (no bold,
 * italic, strikethrough, or code blocks). All formatting markers must be
 * stripped before sending to produce clean plain text.
 *
 * This converter handles:
 * - `toPlatformFormat()` — strips Markdown formatting to plain text
 * - `toMarkdown()` — returns text as-is (already plain text)
 * - `toPlainText()` — strips all formatting markers
 */

import type { FormatConverter } from '@kuralle-agents/messaging';

/**
 * Converts text between Markdown and Messenger's plain-text format.
 *
 * Since Messenger does not support any rich text formatting, both
 * `toPlatformFormat()` and `toPlainText()` strip all Markdown markers.
 *
 * @example
 * ```ts
 * const converter = new MessengerFormatConverter();
 *
 * converter.toPlatformFormat('**bold** and ~~strike~~');
 * // => 'bold and strike'
 *
 * converter.toMarkdown('plain text');
 * // => 'plain text'
 * ```
 */
export class MessengerFormatConverter implements FormatConverter {
  /**
   * Convert Markdown to Messenger's format (plain text).
   *
   * Strips all Markdown formatting since Messenger does not render it:
   * - `**bold**` / `__bold__` becomes `bold`
   * - `_italic_` becomes `italic`
   * - `~~strike~~` becomes `strike`
   * - `` `code` `` becomes `code`
   * - Code blocks are unwrapped
   * - `# Heading` becomes `Heading`
   * - `[text](url)` becomes `text (url)`
   * - `![alt](url)` becomes `alt`
   * - Blockquotes, horizontal rules are removed
   *
   * @param markdown - Markdown-formatted text.
   * @returns Plain text suitable for Messenger.
   */
  toPlatformFormat(markdown: string): string {
    return this.toPlainText(markdown);
  }

  /**
   * Convert Messenger text to Markdown.
   *
   * Since Messenger only supports plain text, this is an identity operation.
   *
   * @param text - Plain text from Messenger.
   * @returns The same text (already valid Markdown).
   */
  toMarkdown(text: string): string {
    return text;
  }

  /**
   * Strip all formatting (Markdown) to produce plain text.
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

    // Remove images but keep alt text
    text = text.replace(/!\[([^\]]*)\]\([^)]+\)/g, '$1');

    // Remove links but keep text and URL
    text = text.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1 ($2)');

    // Remove bold (Markdown)
    text = text.replace(/\*\*(.+?)\*\*/g, '$1');
    text = text.replace(/__(.+?)__/g, '$1');

    // Remove italic
    text = text.replace(/(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)/g, '$1');
    text = text.replace(/(?<!_)_(?!_)(.+?)(?<!_)_(?!_)/g, '$1');

    // Remove strikethrough
    text = text.replace(/~~(.+?)~~/g, '$1');

    // Remove blockquote markers
    text = text.replace(/^>\s?/gm, '');

    // Remove horizontal rules
    text = text.replace(/^(?:---+|\*\*\*+|___+)\s*$/gm, '');

    return text.trim();
  }
}
