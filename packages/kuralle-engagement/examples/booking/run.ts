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
import { buildBookingRouter, buildHoldReminderText } from './bot.js';

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
      const ids =
        interactive.action.type === 'buttons'
          ? interactive.action.buttons.map((b) => b.id).join(',')
          : 'list';
      transcript.push({ kind: 'interactive', detail: ids });
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
  text: string,
  id: string,
): InboundMessage {
  return {
    id,
    platform,
    threadId,
    customerId: 'guest-1',
    from: { id: 'guest-1', name: 'Guest' },
    timestamp: new Date(),
    type: 'text',
    text,
  };
}

function inboundButton(
  platform: string,
  threadId: string,
  slotId: string,
  title: string,
  id: string,
): InboundMessage {
  if (platform === 'whatsapp') {
    return {
      id,
      platform,
      threadId,
      customerId: 'guest-1',
      from: { id: 'guest-1' },
      timestamp: new Date(),
      type: 'interactive',
      interactive: { type: 'button_reply', id: slotId, title },
    };
  }
  return {
    id,
    platform,
    threadId,
    customerId: 'guest-1',
    from: { id: 'guest-1' },
    timestamp: new Date(),
    type: 'text',
    text: slotId,
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
  const whatsapp = createFakePlatform('whatsapp', waTranscript);
  const web = createFakePlatform('web', webTranscript);

  const { sendHoldReminder, windowStore } = buildBookingRouter({
    model: live.model,
    platforms: { whatsapp, web },
  });

  const threadWa = 'demo-wa-thread';
  const threadWeb = 'demo-web-thread';

  console.log(`\n=== Acme Bookings (${live.label}) ===\n`);

  const steps: Array<{ label: string; run: () => Promise<void> }> = [
    {
      label: 'WA greet',
      run: () =>
        whatsapp.deliver(inboundText('whatsapp', threadWa, 'Hi, I need a table', 'wa-1')),
    },
    {
      label: 'WA booking details',
      run: () =>
        whatsapp.deliver(
          inboundText(
            'whatsapp',
            threadWa,
            'Table for 4 on 2026-06-12 around 7pm, name Alex',
            'wa-2',
          ),
        ),
    },
    {
      label: 'WA pick slot (id routes, not label)',
      run: () =>
        whatsapp.deliver(
          inboundButton('whatsapp', threadWa, '19:00', 'Wrong label shown', 'wa-3'),
        ),
    },
    {
      label: 'WA confirm yes',
      run: () =>
        whatsapp.deliver(inboundButton('whatsapp', threadWa, 'yes', 'Yes please', 'wa-4')),
    },
    {
      label: 'Web greet',
      run: () =>
        web.deliver(inboundText('web', threadWeb, 'Book a table for 2', 'web-1')),
    },
    {
      label: 'Web details',
      run: () =>
        web.deliver(
          inboundText('web', threadWeb, '2026-06-20 at 18:30 for Sam', 'web-2'),
        ),
    },
  ];

  for (const step of steps) {
    console.log(`> ${step.label}`);
    await step.run();
    await Bun.sleep(50);
  }

  console.log('\n--- WhatsApp transcript ---');
  for (const line of waTranscript) {
    console.log(`  [${line.kind}] ${line.detail}`);
  }

  console.log('\n--- Web transcript ---');
  for (const line of webTranscript) {
    console.log(`  [${line.kind}] ${line.detail}`);
  }

  const holdState = { partySize: 4, date: '2026-06-12' };
  console.log('\n> Closed-window hold reminder (template conversion)');
  const holdOutcome = await sendHoldReminder(threadWa, 'whatsapp', holdState);
  console.log(`  outcome: ${holdOutcome.kind}`);
  const closedTemplate = waTranscript.filter((t) => t.kind === 'template').pop();
  console.log(`  reminder text: ${buildHoldReminderText(holdState)}`);
  console.log(`  sent template: ${closedTemplate?.detail ?? '(none)'}`);

  await windowStore.recordInbound(threadWa, new Date());
  console.log('\n> Open-window hold reminder (free-form)');
  const openOutcome = await sendHoldReminder(threadWa, 'whatsapp', holdState);
  console.log(`  outcome: ${openOutcome.kind}`);
  const lastText = waTranscript.filter((t) => t.kind === 'text').pop();
  console.log(`  last text: ${lastText?.detail?.slice(0, 80) ?? '(none)'}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
