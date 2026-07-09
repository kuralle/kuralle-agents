/**
 * @module types/responses
 *
 * Outbound send results + format converter interface.
 */

// ====================================
// SEND RESULT
// ====================================

/** Result returned after successfully sending a message. */
export interface SendResult {
  /** Platform-assigned identifier for the sent message. */
  messageId: string;
  /** Thread or conversation the message was sent to. */
  threadId: string;
  /** When the message was accepted by the platform. */
  timestamp: Date;
  /** Raw platform-specific response. */
  raw?: unknown;
}

// ====================================
// FORMAT CONVERTER
// ====================================

/**
 * Converts text between formats for platform-specific rendering.
 *
 * Each platform has its own text formatting rules (WhatsApp uses *bold*,
 * Messenger supports a subset of Markdown, etc.). The converter handles
 * these differences transparently.
 */
export interface FormatConverter {
  /** Convert Markdown text to plain text (strip all formatting). */
  toPlainText(markdown: string): string;
  /** Convert platform-specific formatted text to Markdown. */
  toMarkdown(text: string): string;
  /** Convert Markdown to the platform's native format. */
  toPlatformFormat(markdown: string): string;
}
