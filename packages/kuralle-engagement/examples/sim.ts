#!/usr/bin/env bun

import { buildBookingRouter } from './booking/bot.js';
import { resolveLiveModel } from './_shared/resolveLiveModel.js';

async function main(): Promise<void> {
  const live = resolveLiveModel();
  if (!live) {
    console.log('SKIP: no live key (set OPENAI_API_KEY, GOOGLE_GENERATIVE_AI_API_KEY, or XAI_API_KEY)');
    process.exit(0);
  }

  const { simulator } = buildBookingRouter({
    model: live.model,
    simulatorChannels: ['whatsapp', 'web'],
    simulatorDefaultCustomerId: 'guest-1',
  });
  if (!simulator) {
    throw new Error('expected simulator');
  }

  const threadWa = 'sim-wa';
  console.log(`\n=== kuralle dev simulator (${live.label}) ===\n`);

  await simulator.send('whatsapp', threadWa, { text: 'Hi, table for 2' });
  await simulator.send('whatsapp', threadWa, {
    text: '2026-07-01 at 19:00, name Sam',
  });

  const win = await simulator.window(threadWa);
  console.log(`window open=${win.open} expires=${win.expiresAt?.toISOString() ?? 'null'}\n`);

  for (const line of simulator.sends('whatsapp')) {
    console.log(`[${line.kind}] ${line.detail.slice(0, 160)}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
