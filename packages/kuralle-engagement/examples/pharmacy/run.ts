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
import { buildPharmacyRouter, buildRefillReminderText } from './bot.js';
import { resolveLiveModel } from '../_shared/resolveLiveModel.js';

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
  customerId: string,
  text: string,
  id: string,
): InboundMessage {
  return {
    id,
    platform,
    threadId,
    customerId,
    from: { id: customerId, name: 'Demo Patient' },
    timestamp: new Date(),
    type: 'text',
    text,
  };
}

function inboundButton(
  platform: string,
  threadId: string,
  customerId: string,
  buttonId: string,
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
      interactive: { type: 'button_reply', id: buttonId, title },
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
    text: buttonId,
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

  const customerId = 'patient-demo-1';
  const threadWa = 'demo-pharm-wa';
  const threadWeb = 'demo-pharm-web';

  const { sendRefillReminder, consent, broadcasts, windowStore } = buildPharmacyRouter({
    model: live.model,
    platforms: { whatsapp, web },
  });

  console.log(`\n=== Acme Pharmacy (${live.label}) ===\n`);

  const steps: Array<{ label: string; run: () => Promise<void> }> = [
    {
      label: 'WA greet',
      run: () =>
        whatsapp.deliver(
          inboundText('whatsapp', threadWa, customerId, 'Hi, I need a refill', 'wa-1'),
        ),
    },
    {
      label: 'WA identity',
      run: () =>
        whatsapp.deliver(
          inboundText(
            'whatsapp',
            threadWa,
            customerId,
            'Jane Demo, date of birth 1990-05-15',
            'wa-2',
          ),
        ),
    },
    {
      label: 'WA pick rx (id routes)',
      run: () =>
        whatsapp.deliver(
          inboundButton('whatsapp', threadWa, customerId, 'rx-amox', 'Wrong label', 'wa-3'),
        ),
    },
    {
      label: 'WA insurance',
      run: () =>
        whatsapp.deliver(
          inboundText(
            'whatsapp',
            threadWa,
            customerId,
            'BlueCross member 12345',
            'wa-4',
          ),
        ),
    },
    {
      label: 'WA delivery + address',
      run: async () => {
        await whatsapp.deliver(
          inboundButton('whatsapp', threadWa, customerId, 'delivery', 'Delivery', 'wa-5'),
        );
        await whatsapp.deliver(
          inboundText('whatsapp', threadWa, customerId, '123 Main St, Springfield', 'wa-6'),
        );
      },
    },
    {
      label: 'Web greet + identity',
      run: async () => {
        await web.deliver(
          inboundText('web', threadWeb, customerId, 'Refill please', 'web-1'),
        );
        await web.deliver(
          inboundText('web', threadWeb, customerId, 'Jane Demo 1990-05-15', 'web-2'),
        );
      },
    },
  ];

  for (const step of steps) {
    console.log(`> ${step.label}`);
    await step.run();
    await Bun.sleep(50);
  }

  console.log('\n--- WhatsApp transcript ---');
  for (const line of waTranscript) {
    console.log(`  [${line.kind}] ${line.detail.slice(0, 120)}`);
  }

  await consent.optIn(customerId);
  console.log('\n> Opted in to refill reminders after order (demo)');

  const reminderState = { rxId: 'rx-amox', rxLabel: 'Amoxicillin 500mg' };
  console.log('\n> Closed-window refill reminder (template conversion)');
  const closedOutcome = await sendRefillReminder(
    threadWa,
    customerId,
    'whatsapp',
    reminderState,
  );
  console.log(`  outcome: ${closedOutcome.kind}`);
  console.log(`  reminder text: ${buildRefillReminderText(reminderState)}`);
  const closedTemplate = waTranscript.filter((t) => t.kind === 'template').pop();
  console.log(`  sent template: ${closedTemplate?.detail ?? '(none)'}`);

  const bcast = await broadcasts.send({
    id: 'camp-refill-demo',
    template: { name: 'refill_reminder', language: 'en_US' },
    recipients: [{ customerId, threadId: threadWa }],
  });
  console.log(`\n> Broadcast refill (idempotent): sent=${bcast.sent} skipped=${bcast.skipped}`);

  await windowStore.recordInbound(threadWa, new Date());
  console.log('\n> Open-window refill reminder (free-form)');
  const openOutcome = await sendRefillReminder(
    threadWa,
    customerId,
    'whatsapp',
    reminderState,
  );
  console.log(`  outcome: ${openOutcome.kind}`);

  console.log('\n> STOP opts out of reminders');
  await whatsapp.deliver(
    inboundText('whatsapp', threadWa, customerId, 'STOP', 'wa-stop'),
  );
  const blocked = await sendRefillReminder(
    threadWa,
    customerId,
    'whatsapp',
    reminderState,
  );
  console.log(`  post-STOP send outcome: ${blocked.kind} (${'reason' in blocked ? blocked.reason : 'n/a'})`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
