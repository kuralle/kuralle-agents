#!/usr/bin/env bun

import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type {
  InboundMessage,
  OutboundSink,
  OutboundTemplate,
  PlatformClient,
  SendResult,
} from '@kuralle-agents/messaging';
import { createOpenAI } from '@ai-sdk/openai';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { createXai } from '@ai-sdk/xai';
import type { LanguageModel } from 'ai';
import { buildClothingRouter, promoDropTemplate } from './bot.js';

function loadEnv(): void {
  const dir = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    join(dir, '../../../../.env'),
    join(dir, '../../../.env'),
    join(process.cwd(), '.env'),
  ];
  for (const path of candidates) {
    if (!existsSync(path)) continue;
    for (const line of readFileSync(path, 'utf8').split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eq = trimmed.indexOf('=');
      if (eq <= 0) continue;
      const key = trimmed.slice(0, eq).trim();
      let value = trimmed.slice(eq + 1).trim();
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }
      if (process.env[key] === undefined) {
        process.env[key] = value;
      }
    }
    break;
  }
}

function resolveLiveModel(): { model: LanguageModel; label: string } | null {
  const google = process.env.GOOGLE_GENERATIVE_AI_API_KEY;
  if (google) {
    return {
      model: createGoogleGenerativeAI({ apiKey: google })('gemini-2.0-flash'),
      label: 'google:gemini-2.0-flash',
    };
  }
  const xai = process.env.XAI_API_KEY;
  if (xai) {
    return { model: createXai({ apiKey: xai })('grok-2-1212'), label: 'xai:grok-2-1212' };
  }
  const openaiKey = process.env.OPENAI_API_KEY;
  if (openaiKey) {
    return {
      model: createOpenAI({ apiKey: openaiKey })(process.env.OPENAI_MODEL ?? 'gpt-4o-mini'),
      label: `openai:${process.env.OPENAI_MODEL ?? 'gpt-4o-mini'}`,
    };
  }
  return null;
}

type RecordedSend = { kind: 'text' | 'template' | 'interactive'; detail: string };

function createFakePlatform(
  name: string,
  transcript: RecordedSend[],
): PlatformClient & OutboundSink & {
  deliver: (message: InboundMessage) => Promise<void>;
} {
  const handlers: Array<(message: InboundMessage, raw: unknown) => Promise<void>> = [];
  const makeResult = (threadId: string): SendResult => ({
    messageId: `msg-${transcript.length}`,
    threadId,
    timestamp: new Date(),
  });

  return {
    platform: name,
    handleWebhook: async () => new Response('OK'),
    onMessage: (handler) => {
      handlers.push(handler);
    },
    onStatus: () => {},
    onReaction: () => {},
    sendText: async (to, text) => {
      transcript.push({ kind: 'text', detail: text });
      return makeResult(to);
    },
    sendTemplate: async (to: string, template: OutboundTemplate) => {
      transcript.push({ kind: 'template', detail: template.name });
      return makeResult(to);
    },
    sendInteractive: async (to, interactive) => {
      const detail =
        interactive.action.type === 'buttons'
          ? `buttons:${interactive.action.buttons.map((b) => b.id).join(',')}`
          : interactive.action.type === 'list'
            ? `list:${interactive.action.sections[0]?.rows.map((r) => r.id).join(',') ?? ''}`
            : interactive.action.type;
      transcript.push({ kind: 'interactive', detail });
      return makeResult(to);
    },
    sendMedia: async (to) => makeResult(to),
    sendRaw: async (to) => makeResult(to),
    markAsRead: async () => {},
    sendTypingIndicator: async () => {},
    uploadMedia: async () => ({ mediaId: 'mock' }),
    downloadMedia: async () => ({ data: Buffer.from(''), mimeType: 'text/plain' }),
    formatConverter: {
      toPlainText: (t) => t,
      toMarkdown: (t) => t,
      toPlatformFormat: (t) => t,
    },
    webhookRouter: () => {
      throw new Error('webhook not used in example run');
    },
    deliver: async (message) => {
      for (const handler of handlers) {
        await handler(message, message);
      }
    },
  };
}

function inboundText(
  platform: string,
  threadId: string,
  customerId: string,
  text: string,
  id: string,
): InboundMessage {
  return {
    id,
    platform,
    threadId,
    customerId,
    from: { id: customerId, name: 'Demo Shopper' },
    timestamp: new Date(),
    type: 'text',
    text,
  };
}

function inboundChoice(
  platform: string,
  threadId: string,
  customerId: string,
  choiceId: string,
  title: string,
  id: string,
): InboundMessage {
  if (platform === 'whatsapp') {
    return {
      id,
      platform,
      threadId,
      customerId,
      from: { id: customerId },
      timestamp: new Date(),
      type: 'interactive',
      interactive: { type: 'button_reply', id: choiceId, title },
    };
  }
  if (platform === 'instagram') {
    return {
      id,
      platform,
      threadId,
      customerId,
      from: { id: customerId },
      timestamp: new Date(),
      type: 'interactive',
      button: { payload: choiceId, text: title },
    };
  }
  return {
    id,
    platform,
    threadId,
    customerId,
    from: { id: customerId },
    timestamp: new Date(),
    type: 'text',
    text: choiceId,
  };
}

async function main(): Promise<void> {
  loadEnv();
  const live = resolveLiveModel();
  if (!live) {
    console.log('SKIP: no live key (set OPENAI_API_KEY, GOOGLE_GENERATIVE_AI_API_KEY, or XAI_API_KEY)');
    process.exit(0);
  }

  const waTranscript: RecordedSend[] = [];
  const webTranscript: RecordedSend[] = [];
  const igTranscript: RecordedSend[] = [];
  const whatsapp = createFakePlatform('whatsapp', waTranscript);
  const web = createFakePlatform('web', webTranscript);
  const instagram = createFakePlatform('instagram', igTranscript);

  const customerId = 'shopper-demo-1';
  const threadWa = 'demo-cloth-wa';
  const threadWeb = 'demo-cloth-web';
  const threadIg = 'demo-cloth-ig';

  const { router: _router, consent, broadcasts } = buildClothingRouter({
    model: live.model,
    platforms: { whatsapp, web, instagram },
  });
  void _router;

  console.log(`\n=== Acme Threads (${live.label}) ===\n`);

  const shopOn = async (
    platform: PlatformClient & { deliver: (m: InboundMessage) => Promise<void> },
    threadId: string,
    platformName: string,
    prefix: string,
  ) => {
    await platform.deliver(
      inboundText(platformName, threadId, customerId, 'SHOP', `${prefix}-0`),
    );
    await platform.deliver(
      inboundChoice(platformName, threadId, customerId, 'tee', 'Wrong label', `${prefix}-1`),
    );
    const sizeSend = platformName === 'whatsapp' || platformName === 'instagram'
      ? inboundChoice(platformName, threadId, customerId, 'm', 'Medium', `${prefix}-size`)
      : inboundText(platformName, threadId, customerId, 'm', `${prefix}-size`);
    await platform.deliver(sizeSend);
    await platform.deliver(
      inboundChoice(platformName, threadId, customerId, 'black', 'Noir', `${prefix}-color`),
    );
    await Bun.sleep(80);
  };

  console.log('> WhatsApp shop (size list on 4 options)');
  await shopOn(whatsapp, threadWa, 'whatsapp', 'wa');

  console.log('> Instagram shop (carousel/list on 4 options)');
  await shopOn(instagram, threadIg, 'instagram', 'ig');

  console.log('> Web shop');
  await shopOn(web, threadWeb, 'web', 'web');

  const lastWaInteractive = waTranscript.filter((t) => t.kind === 'interactive').pop();
  const lastIgInteractive = igTranscript.filter((t) => t.kind === 'interactive').pop();
  console.log('\n--- Size picker outbound (same ids, channel-specific shape) ---');
  console.log(`  WA:  ${lastWaInteractive?.detail ?? '(none)'}`);
  console.log(`  IG:  ${lastIgInteractive?.detail ?? '(none)'}`);

  console.log('\n--- WhatsApp transcript (tail) ---');
  for (const line of waTranscript.slice(-6)) {
    console.log(`  [${line.kind}] ${line.detail.slice(0, 100)}`);
  }

  await consent.optIn(customerId);
  console.log('\n> Promo broadcast (opted-in only, idempotent)');
  const promo = await broadcasts.send({
    id: 'camp-promo-drop-demo',
    template: { name: promoDropTemplate.name, language: 'en_US' },
    recipients: [{ customerId, threadId: threadWa }],
  });
  console.log(`  first send: sent=${promo.sent} skipped=${promo.skipped}`);
  const promoRetry = await broadcasts.send({
    id: 'camp-promo-drop-demo',
    template: { name: promoDropTemplate.name, language: 'en_US' },
    recipients: [{ customerId, threadId: threadWa }],
  });
  console.log(`  retry:      sent=${promoRetry.sent} skipped=${promoRetry.skipped}`);
  const templates = waTranscript.filter((t) => t.kind === 'template');
  console.log(`  templates sent: ${templates.map((t) => t.detail).join(', ') || '(none)'}`);

  console.log('\n> Reply SHOP after promo (re-enters flow)');
  await whatsapp.deliver(
    inboundText('whatsapp', threadWa, customerId, 'SHOP', 'wa-promo-reply'),
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
