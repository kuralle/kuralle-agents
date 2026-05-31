/**
 * @module whatsapp/format
 *
 * WhatsApp-specific text format converter.
 *
 * WhatsApp uses a unique formatting syntax that differs from standard Markdown:
 * - Bold: `*text*` (Markdown: `**text**`)
 * - Italic: `_text_` (same as Markdown)
 * - Strikethrough: `~text~` (Markdown: `~~text~~`)
 * - Monospace: `` `code` `` (same as Markdown)
 * - Code block: ` ```block``` ` (same as Markdown)
 *
 * This converter handles bidirectional translation between Markdown and
 * WhatsApp's native format, as well as stripping all formatting to plain text.
 */

import type { FormatConverter } from '@kuralle-agents/messaging';

/**
 * Converts text between Markdown and WhatsApp's native formatting syntax.
 *
 * @example
 * ```ts
 * const converter = new WhatsAppFormatConverter();
 *
 * // Markdown to WhatsApp
 * converter.toPlatformFormat('**bold** and ~~strike~~');
 * // => '*bold* and ~strike~'
 *
 * // WhatsApp to Markdown
 * converter.toMarkdown('*bold* and ~strike~');
 * // => '**bold** and ~~strike~~'
 * ```
 */
export class WhatsAppFormatConverter implements FormatConverter {
  /**
   * Convert standard Markdown to WhatsApp's native formatting.
   *
   * Transformations applied:
   * - `**bold**` or `__bold__` becomes `*bold*`
   * - `~~strike~~` becomes `~strike~`
   * - `# Heading` becomes `*Heading*` (bold)
   * - `## Heading` becomes `*Heading*`
   * - `### Heading` becomes `*Heading*`
   * - `---` or `***` horizontal rules become `━━━━━━━━━━`
   * - `[text](url)` becomes `text (url)`
   * - `![alt](url)` becomes `alt`
   * - Tables are converted to code-block ASCII representation
   * - Italic (`_text_`) and inline code (`` `code` ``) are preserved
   *
   * @param markdown - Markdown-formatted text.
   * @returns Text formatted for WhatsApp.
   */
  toPlatformFormat(markdown: string): string {
    let text = markdown;

    // Preserve code blocks from being transformed
    const codeBlocks: string[] = [];
    text = text.replace(/```[\s\S]*?```/g, (match) => {
      codeBlocks.push(match);
      return `\x00CB${codeBlocks.length - 1}\x00`;
    });

    // Preserve inline code
    const inlineCode: string[] = [];
    text = text.replace(/`[^`]+`/g, (match) => {
      inlineCode.push(match);
      return `\x00IC${inlineCode.length - 1}\x00`;
    });

    // Convert Markdown tables to code-block ASCII
    text = this.convertTables(text);

    // Headings → bold
    text = text.replace(/^#{1,6}\s+(.+)$/gm, '*$1*');

    // Horizontal rules → line
    text = text.replace(/^(?:---+|\*\*\*+|___+)\s*$/gm, '\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501');

    // Unordered list markers: normalize * and + bullets to dashes BEFORE bold
    // conversion, since `* item` would become `- item` correctly, but after
    // bold conversion `*bold*` at line start would be mistakenly treated as a bullet.
    text = text.replace(/^(\s*)[*+]\s/gm, '$1- ');

    // Bold: **text** or __text__ → *text*
    text = text.replace(/\*\*(.+?)\*\*/g, '*$1*');
    text = text.replace(/__(.+?)__/g, '*$1*');

    // Strikethrough: ~~text~~ → ~text~
    text = text.replace(/~~(.+?)~~/g, '~$1~');

    // Links: [text](url) → text (url)
    text = text.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1 ($2)');

    // Images: ![alt](url) → alt
    text = text.replace(/!\[([^\]]*)\]\([^)]+\)/g, '$1');

    // Blockquotes: > text → text (remove the > prefix)
    text = text.replace(/^>\s?/gm, '');

    // Restore inline code
    text = text.replace(/\x00IC(\d+)\x00/g, (_, idx) => inlineCode[parseInt(idx)]);

    // Restore code blocks
    text = text.replace(/\x00CB(\d+)\x00/g, (_, idx) => codeBlocks[parseInt(idx)]);

    return text;
  }

  /**
   * Convert WhatsApp-formatted text to standard Markdown.
   *
   * Transformations applied:
   * - `*bold*` becomes `**bold**`
   * - `~strike~` becomes `~~strike~~`
   * - Italic (`_text_`) and code (`` `code` ``) are already Markdown-compatible
   *
   * @param text - WhatsApp-formatted text.
   * @returns Markdown-formatted text.
   */
  toMarkdown(text: string): string {
    let result = text;

    // Preserve code blocks
    const codeBlocks: string[] = [];
    result = result.replace(/```[\s\S]*?```/g, (match) => {
      codeBlocks.push(match);
      return `\x00CB${codeBlocks.length - 1}\x00`;
    });

    // Preserve inline code
    const inlineCode: string[] = [];
    result = result.replace(/`[^`]+`/g, (match) => {
      inlineCode.push(match);
      return `\x00IC${inlineCode.length - 1}\x00`;
    });

    // Bold: *text* → **text**
    // Match single asterisks that are not part of code or escaped
    result = result.replace(/(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)/g, '**$1**');

    // Strikethrough: ~text~ → ~~text~~
    result = result.replace(/(?<!~)~(?!~)(.+?)(?<!~)~(?!~)/g, '~~$1~~');

    // Restore inline code
    result = result.replace(/\x00IC(\d+)\x00/g, (_, idx) => inlineCode[parseInt(idx)]);

    // Restore code blocks
    result = result.replace(/\x00CB(\d+)\x00/g, (_, idx) => codeBlocks[parseInt(idx)]);

    return result;
  }

  /**
   * Strip all formatting (Markdown and WhatsApp) to produce plain text.
   *
   * @param markdown - Markdown or WhatsApp-formatted text.
   * @returns Plain text with all formatting markers removed.
   */
  toPlainText(markdown: string): string {
    let text = markdown;

    // Remove code blocks but keep content
    text = text.replace(/```(?:\w*\n)?([\s\S]*?)```/g, '$1');

    // Remove inline code markers
    text = text.replace(/`([^`]+)`/g, '$1');

    // Remove headings markers
    text = text.replace(/^#{1,6}\s+/gm, '');

    // Remove images
    text = text.replace(/!\[([^\]]*)\]\([^)]+\)/g, '$1');

    // Remove links but keep text
    text = text.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1');

    // Remove bold (Markdown and WhatsApp)
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

  // -----------------------------------------------------------------------
  // Private helpers
  // -----------------------------------------------------------------------

  /**
   * Convert Markdown tables to a code-block ASCII representation suitable
   * for WhatsApp (which does not support tables natively).
   */
  private convertTables(text: string): string {
    // Match simple Markdown tables (header, separator, rows)
    const tableRegex = /^(\|.+\|)\n(\|[-| :]+\|)\n((?:\|.+\|\n?)+)/gm;

    return text.replace(tableRegex, (match) => {
      const lines = match.trim().split('\n');
      if (lines.length < 3) return match;

      // Parse cells
      const parseCells = (line: string): string[] =>
        line.split('|').slice(1, -1).map(cell => cell.trim());

      const headerCells = parseCells(lines[0]);
      const dataRows = lines.slice(2).map(parseCells);

      // Calculate column widths
      const colWidths = headerCells.map((h, i) => {
        const maxData = dataRows.reduce((max, row) => Math.max(max, (row[i] ?? '').length), 0);
        return Math.max(h.length, maxData);
      });

      // Build ASCII table
      const pad = (str: string, width: number) => str.padEnd(width);
      const separator = colWidths.map(w => '\u2500'.repeat(w + 2)).join('\u253C');

      const formatRow = (cells: string[]) =>
        cells.map((cell, i) => ` ${pad(cell, colWidths[i])} `).join('\u2502');

      const headerLine = formatRow(headerCells);
      const bodyLines = dataRows.map(formatRow);

      return '```\n' + headerLine + '\n' + separator + '\n' + bodyLines.join('\n') + '\n```';
    });
  }
}
