#!/usr/bin/env bun

import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
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

async function main(): Promise<void> {
  loadEnv();
  const live = resolveLiveModel();
  if (!live) {
    console.log('SKIP: no live key (set OPENAI_API_KEY, GOOGLE_GENERATIVE_AI_API_KEY, or XAI_API_KEY)');
    process.exit(0);
  }

  const customerId = 'patient-demo-1';
  const threadWa = 'demo-pharm-wa';
  const threadWeb = 'demo-pharm-web';

  const { sendRefillReminder, consent, broadcasts, windowStore, simulator } = buildPharmacyRouter({
    model: live.model,
    simulatorChannels: ['whatsapp', 'web'],
    simulatorDefaultCustomerId: customerId,
  });
  if (!simulator) {
    throw new Error('expected simulator from buildPharmacyRouter');
  }

  console.log(`\n=== Acme Pharmacy (${live.label}) ===\n`);

  const steps: Array<{ label: string; run: () => Promise<void> }> = [
    {
      label: 'WA greet',
      run: async () => {
        await simulator.send('whatsapp', threadWa, { text: 'Hi, I need a refill' });
      },
    },
    {
      label: 'WA identity',
      run: async () => {
        await simulator.send('whatsapp', threadWa, {
          text: 'Jane Demo, date of birth 1990-05-15',
        });
      },
    },
    {
      label: 'WA pick rx (id routes)',
      run: async () => {
        await simulator.send('whatsapp', threadWa, {
          interactive: { id: 'rx-amox', title: 'Wrong label' },
        });
      },
    },
    {
      label: 'WA insurance',
      run: async () => {
        await simulator.send('whatsapp', threadWa, {
          text: 'BlueCross member 12345',
        });
      },
    },
    {
      label: 'WA delivery + address',
      run: async () => {
        await simulator.send('whatsapp', threadWa, {
          interactive: { id: 'delivery', title: 'Delivery' },
        });
        await simulator.send('whatsapp', threadWa, {
          text: '123 Main St, Springfield',
        });
      },
    },
    {
      label: 'Web greet + identity',
      run: async () => {
        await simulator.send('web', threadWeb, { text: 'Refill please' });
        await simulator.send('web', threadWeb, { text: 'Jane Demo 1990-05-15' });
      },
    },
  ];

  for (const step of steps) {
    console.log(`> ${step.label}`);
    await step.run();
    await Bun.sleep(50);
  }

  console.log('\n--- WhatsApp transcript ---');
  for (const line of simulator.sends('whatsapp')) {
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
  const closedTemplate = simulator
    .sends('whatsapp')
    .filter((t) => t.kind === 'template')
    .pop();
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
  await simulator.send('whatsapp', threadWa, { text: 'STOP' });
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
