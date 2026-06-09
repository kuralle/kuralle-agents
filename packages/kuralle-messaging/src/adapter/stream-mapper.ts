import type { HarnessStreamPart } from '@kuralle-agents/core';
import type { PlatformClient, StreamMapperOptions } from '../types.js';
import type { OutboundMeta, OutboundPayload, SendOutcome } from '../types/outbound.js';
import type { SendResult } from '../types/responses.js';
import type { OutboundPipeline } from './outbound-pipeline.js';
import type { WindowStore } from './window-store.js';
import { renderChoices } from './render-choices.js';

/** Default interval for sending typing indicators during streaming (ms). */
const DEFAULT_TYPING_INTERVAL_MS = 5_000;

function outcomeToSendResult(threadId: string, outcome: SendOutcome): SendResult {
  if (outcome.kind === 'sent' || outcome.kind === 'converted') {
    return outcome.result;
  }
  return { messageId: '', threadId, timestamp: new Date() };
}

export class StreamMapper {
  async mapStream(
    stream: AsyncIterable<HarnessStreamPart>,
    platform: PlatformClient,
    threadId: string,
    options: StreamMapperOptions,
  ): Promise<HarnessStreamPart[]> {
    const parts: HarnessStreamPart[] = [];
    let textBuffer = '';
    const typingIntervalMs = options.typingIntervalMs ?? DEFAULT_TYPING_INTERVAL_MS;

    let typingActive = true;
    const typingInterval = setInterval(async () => {
      if (!typingActive) return;
      try {
        await platform.sendTypingIndicator(threadId);
      } catch {
        // Non-critical
      }
    }, typingIntervalMs);

    try {
      await platform.sendTypingIndicator(threadId);
    } catch {
      // Non-critical
    }

    try {
      for await (const part of stream) {
        parts.push(part);
        if (part.type === 'text-delta') {
          textBuffer += part.delta;
        }
      }

      typingActive = false;
      clearInterval(typingInterval);

      const meta = await this.buildMeta(
        options.windowStore,
        threadId,
        parts,
        options.sessionId,
        options.userId,
      );

      if (options.responseMapper) {
        await options.responseMapper.mapResponse(parts, {
          threadId,
          platform: platform.platform,
          sendText: (text) =>
            this.sendFreeform(options.pipeline, platform, threadId, { kind: 'text', text }, meta),
          sendInteractive: (msg) =>
            this.sendFreeform(
              options.pipeline,
              platform,
              threadId,
              { kind: 'interactive', interactive: msg },
              meta,
            ),
          sendMedia: (media) =>
            this.sendFreeform(
              options.pipeline,
              platform,
              threadId,
              { kind: 'media', media },
              meta,
            ),
        });
      } else {
        await this.defaultMapResponse(
          options.pipeline,
          platform,
          threadId,
          textBuffer,
          meta,
          parts,
        );
      }
    } finally {
      typingActive = false;
      clearInterval(typingInterval);
    }

    return parts;
  }

  private async buildMeta(
    windowStore: WindowStore,
    threadId: string,
    parts: HarnessStreamPart[],
    sessionId: string,
    userId?: string,
  ): Promise<OutboundMeta> {
    const window = await windowStore.get(threadId);
    return { window, parts, sessionId, userId };
  }

  private async sendFreeform(
    pipeline: OutboundPipeline,
    platform: PlatformClient,
    threadId: string,
    payload: OutboundPayload,
    meta: OutboundMeta,
  ): Promise<SendResult> {
    const outcome = await pipeline.send({
      threadId,
      platform: platform.platform,
      payload,
      meta,
    });
    if (outcome.kind === 'deferred' || outcome.kind === 'suppressed') {
      return outcomeToSendResult(threadId, outcome);
    }
    if (outcome.kind === 'sent' || outcome.kind === 'converted') {
      return outcome.result;
    }
    return outcomeToSendResult(threadId, outcome);
  }

  private async defaultMapResponse(
    pipeline: OutboundPipeline,
    platform: PlatformClient,
    threadId: string,
    text: string,
    meta: OutboundMeta,
    parts: HarnessStreamPart[],
  ): Promise<void> {
    // A turn that ends with an `interactive` part (flow choices) renders as a
    // native interactive message; its prompt IS the user-facing question, so
    // accumulated text is sent first only when it adds something beyond it.
    const interactivePart = [...parts]
      .reverse()
      .find(
        (part): part is Extract<HarnessStreamPart, { type: 'interactive' }> =>
          part.type === 'interactive',
      );
    if (interactivePart) {
      const trimmed = text.trim();
      if (trimmed.length > 0 && trimmed !== interactivePart.prompt.trim()) {
        await pipeline.send({
          threadId,
          platform: platform.platform,
          payload: { kind: 'text', text: platform.formatConverter.toPlatformFormat(trimmed) },
          meta,
        });
      }
      await pipeline.send({
        threadId,
        platform: platform.platform,
        payload: {
          kind: 'interactive',
          interactive: renderChoices(interactivePart.options, interactivePart.prompt),
        },
        meta,
      });
      return;
    }

    if (text.trim().length === 0) return;

    const formatted = platform.formatConverter.toPlatformFormat(text);
    const outcome = await pipeline.send({
      threadId,
      platform: platform.platform,
      payload: { kind: 'text', text: formatted },
      meta,
    });

    if (outcome.kind === 'sent' || outcome.kind === 'converted') {
      return;
    }
    if (outcome.kind === 'deferred' || outcome.kind === 'suppressed') {
      return;
    }
  }
}
