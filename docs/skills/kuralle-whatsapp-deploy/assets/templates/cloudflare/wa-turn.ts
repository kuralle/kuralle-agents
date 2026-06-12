import type { Runtime, UserInputContent } from '@kuralle-agents/core';
import type { NormalizedMessage } from '@kuralle-agents/messaging-meta/webhooks';
import { PAYMENT_SIGNAL } from './token.js';

/**
 * The slice of a WhatsApp client this bot uses. Kept narrow so the turn logic
 * is unit-testable with a fake (see wa.test.ts) — no live Meta needed.
 */
export interface WhatsAppSender {
  sendText(to: string, text: string): Promise<unknown>;
  downloadMedia(mediaId: string): Promise<{ data: { toString(enc: 'base64'): string }; mimeType: string }>;
}

/**
 * Turn an inbound WhatsApp message into runtime input. An inbound image (the
 * prescription) is downloaded from Meta's CDN and attached as an AI-SDK `file`
 * part — the same multimodal shape the vision model already reads on the web.
 */
export async function buildWhatsAppInput(
  message: NormalizedMessage,
  whatsapp: WhatsAppSender,
): Promise<UserInputContent | null> {
  const caption = message.text?.body ?? message.image?.caption ?? '';
  const text = caption.trim();

  if (message.image) {
    const download = await whatsapp.downloadMedia(message.image.id);
    const parts: Exclude<UserInputContent, string> = [];
    if (text) parts.push({ type: 'text', text });
    parts.push({
      type: 'file',
      data: download.data.toString('base64'),
      mediaType: message.image.mime_type || download.mimeType,
      filename: 'rx.jpg',
    });
    return parts;
  }

  return text ? text : null;
}

async function drain(handle: { events: AsyncIterable<{ type: string; delta?: string }> } & PromiseLike<unknown>) {
  let text = '';
  for await (const part of handle.events) {
    if (part.type === 'text-delta' && typeof part.delta === 'string') text += part.delta;
  }
  await handle;
  return text.trim();
}

/** Run one inbound WhatsApp turn and send the agent's reply back to the user. */
export async function runWhatsAppTurn(opts: {
  runtime: Runtime;
  whatsapp: WhatsAppSender;
  from: string;
  message: NormalizedMessage;
}): Promise<{ text: string }> {
  const input = await buildWhatsAppInput(opts.message, opts.whatsapp);
  if (input == null) return { text: '' };

  const handle = opts.runtime.run({ input, sessionId: opts.from });
  const text = await drain(handle);
  if (text) await opts.whatsapp.sendText(opts.from, text);
  return { text };
}

/**
 * Resume a suspended checkout after the `/wa-pay` link is hit. Delivers the
 * durable payment signal (idempotent via the effect log) and pushes the order
 * confirmation to the user — the off-Cloudflare counterpart of the DO `/resume`.
 */
export async function resumeWhatsAppPayment(opts: {
  runtime: Runtime;
  whatsapp: WhatsAppSender;
  from: string;
  signalId: string;
}): Promise<{ text: string }> {
  const handle = opts.runtime.run({
    sessionId: opts.from,
    signalDelivery: { signalId: opts.signalId, name: PAYMENT_SIGNAL, payload: { paid: true } },
  });
  const text = await drain(handle);
  if (text) await opts.whatsapp.sendText(opts.from, text);
  return { text };
}
