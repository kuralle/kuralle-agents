#!/usr/bin/env bun

import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildBookingRouter, buildHoldReminderText } from './bot.js';
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

  const { sendHoldReminder, windowStore, simulator } = buildBookingRouter({
    model: live.model,
    simulatorChannels: ['whatsapp', 'web'],
    simulatorDefaultCustomerId: 'guest-1',
  });
  if (!simulator) {
    throw new Error('expected simulator from buildBookingRouter');
  }

  const threadWa = 'demo-wa-thread';
  const threadWeb = 'demo-web-thread';

  console.log(`\n=== Acme Bookings (${live.label}) ===\n`);

  const steps: Array<{ label: string; run: () => Promise<void> }> = [
    {
      label: 'WA greet',
      run: async () => {
        await simulator.send('whatsapp', threadWa, { text: 'Hi, I need a table' });
      },
    },
    {
      label: 'WA booking details',
      run: async () => {
        await simulator.send('whatsapp', threadWa, {
          text: 'Table for 4 on 2026-06-12 around 7pm, name Alex',
        });
      },
    },
    {
      label: 'WA pick slot (id routes, not label)',
      run: async () => {
        await simulator.send('whatsapp', threadWa, {
          interactive: { id: '19:00', title: 'Wrong label shown' },
        });
      },
    },
    {
      label: 'WA confirm yes',
      run: async () => {
        await simulator.send('whatsapp', threadWa, {
          interactive: { id: 'yes', title: 'Yes please' },
        });
      },
    },
    {
      label: 'Web greet',
      run: async () => {
        await simulator.send('web', threadWeb, { text: 'Book a table for 2' });
      },
    },
    {
      label: 'Web details',
      run: async () => {
        await simulator.send('web', threadWeb, {
          text: '2026-06-20 at 18:30 for Sam',
        });
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
    console.log(`  [${line.kind}] ${line.detail}`);
  }

  console.log('\n--- Web transcript ---');
  for (const line of simulator.sends('web')) {
    console.log(`  [${line.kind}] ${line.detail}`);
  }

  const holdState = { partySize: 4, date: '2026-06-12' };
  console.log('\n> Closed-window hold reminder (template conversion)');
  const holdOutcome = await sendHoldReminder(threadWa, 'whatsapp', holdState);
  console.log(`  outcome: ${holdOutcome.kind}`);
  const closedTemplate = simulator
    .sends('whatsapp')
    .filter((t) => t.kind === 'template')
    .pop();
  console.log(`  reminder text: ${buildHoldReminderText(holdState)}`);
  console.log(`  sent template: ${closedTemplate?.detail ?? '(none)'}`);

  await windowStore.recordInbound(threadWa, new Date());
  console.log('\n> Open-window hold reminder (free-form)');
  const openOutcome = await sendHoldReminder(threadWa, 'whatsapp', holdState);
  console.log(`  outcome: ${openOutcome.kind}`);
  const lastText = simulator
    .sends('whatsapp')
    .filter((t) => t.kind === 'text')
    .pop();
  console.log(`  last text: ${lastText?.detail?.slice(0, 80) ?? '(none)'}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
