import type { HarnessStreamPart } from '@kuralle-agents/core';
import type {
  PlatformClient,
  ResponseMapper,
  StreamMapperOptions,
  InteractiveMessage,
} from '../types.js';

/** Default interval for sending typing indicators during streaming (ms). */
const DEFAULT_TYPING_INTERVAL_MS = 5_000;

/**
 * Maps an Kuralle runtime stream to platform messages.
 *
 * The mapper:
 * 1. Starts a typing indicator interval on the platform
 * 2. Buffers all `text-delta` events into a complete response string
 * 3. Collects metadata events (suggested-questions, handoff, flow-end, done)
 * 4. When the stream completes, either delegates to a custom `ResponseMapper`
 *    or uses the default behavior:
 *    - Sends the accumulated text via `platform.sendText()`
 *    - If suggested questions exist, sends them as interactive buttons
 * 5. Clears the typing indicator
 * 6. Returns all collected stream parts
 */
export class StreamMapper {
  /**
   * Consume an Kuralle runtime stream and send the response to a platform.
   *
   * @param stream - The async iterable from `runtime.stream()`.
   * @param platform - The platform client to send messages through.
   * @param threadId - The thread to send responses to.
   * @param options - Optional configuration for response mapping and typing interval.
   * @returns All collected stream parts for inspection or logging.
   */
  async mapStream(
    stream: AsyncIterable<HarnessStreamPart>,
    platform: PlatformClient,
    threadId: string,
    options?: StreamMapperOptions,
  ): Promise<HarnessStreamPart[]> {
    const parts: HarnessStreamPart[] = [];
    let textBuffer = '';
    const typingIntervalMs = options?.typingIntervalMs ?? DEFAULT_TYPING_INTERVAL_MS;

    // Start typing indicator loop
    let typingActive = true;
    const typingInterval = setInterval(async () => {
      if (!typingActive) return;
      try {
        await platform.sendTypingIndicator(threadId);
      } catch {
        // Typing indicator failures are non-critical — silently ignore
      }
    }, typingIntervalMs);

    // Send an initial typing indicator immediately
    try {
      await platform.sendTypingIndicator(threadId);
    } catch {
      // Non-critical
    }

    try {
      for await (const part of stream) {
        parts.push(part);

        switch (part.type) {
          case 'text-delta':
            textBuffer += part.text;
            break;
          // All other event types are collected for the response mapper
          // but don't require special handling during streaming
        }
      }

      // Stop typing indicator
      typingActive = false;
      clearInterval(typingInterval);

      // Delegate to custom response mapper or use default behavior
      if (options?.responseMapper) {
        await options.responseMapper.mapResponse(parts, {
          threadId,
          platform: platform.platform,
          sendText: (text: string) => platform.sendText(threadId, text),
          sendInteractive: (msg: InteractiveMessage) => platform.sendInteractive(threadId, msg),
          sendMedia: (media) => platform.sendMedia(threadId, media),
        });
      } else {
        await this.defaultMapResponse(platform, threadId, textBuffer, parts);
      }
    } finally {
      // Ensure typing indicator is always cleaned up
      typingActive = false;
      clearInterval(typingInterval);
    }

    return parts;
  }

  /**
   * Default response mapping: send accumulated text and optional suggested questions.
   */
  private async defaultMapResponse(
    platform: PlatformClient,
    threadId: string,
    text: string,
    parts: HarnessStreamPart[],
  ): Promise<void> {
    // Send the accumulated text response
    if (text.trim().length > 0) {
      const formatted = platform.formatConverter.toPlatformFormat(text);
      await platform.sendText(threadId, formatted);
    }
  }
}
