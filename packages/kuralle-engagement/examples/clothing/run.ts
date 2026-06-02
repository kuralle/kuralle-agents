#!/usr/bin/env bun

import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildClothingRouter, promoDropTemplate } from './bot.js';
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

  const customerId = 'shopper-demo-1';
  const threadWa = 'demo-cloth-wa';
  const threadWeb = 'demo-cloth-web';
  const threadIg = 'demo-cloth-ig';

  const { consent, broadcasts, simulator } = buildClothingRouter({
    model: live.model,
    simulatorChannels: ['whatsapp', 'web', 'instagram'],
    simulatorDefaultCustomerId: customerId,
  });
  if (!simulator) {
    throw new Error('expected simulator from buildClothingRouter');
  }

  console.log(`\n=== Acme Threads (${live.label}) ===\n`);

  const shopOn = async (
    channel: string,
    threadId: string,
    prefix: string,
  ) => {
    await simulator.send(channel, threadId, { text: 'SHOP' });
    await simulator.send(channel, threadId, {
      interactive: { id: 'tee', title: 'Wrong label' },
    });
    if (channel === 'whatsapp' || channel === 'instagram') {
      await simulator.send(channel, threadId, {
        interactive: { id: 'm', title: 'Medium' },
      });
    } else {
      await simulator.send(channel, threadId, { text: 'm' });
    }
    await simulator.send(channel, threadId, {
      interactive: { id: 'black', title: 'Noir' },
    });
    await Bun.sleep(80);
  };

  console.log('> WhatsApp shop (size list on 4 options)');
  await shopOn('whatsapp', threadWa, 'wa');

  console.log('> Instagram shop (carousel/list on 4 options)');
  await shopOn('instagram', threadIg, 'ig');

  console.log('> Web shop');
  await shopOn('web', threadWeb, 'web');

  const lastWaInteractive = simulator
    .sends('whatsapp')
    .filter((t) => t.kind === 'interactive')
    .pop();
  const lastIgInteractive = simulator
    .sends('instagram')
    .filter((t) => t.kind === 'interactive')
    .pop();
  console.log('\n--- Size picker outbound (same ids, channel-specific shape) ---');
  console.log(`  WA:  ${lastWaInteractive?.detail ?? '(none)'}`);
  console.log(`  IG:  ${lastIgInteractive?.detail ?? '(none)'}`);

  console.log('\n--- WhatsApp transcript (tail) ---');
  for (const line of simulator.sends('whatsapp').slice(-6)) {
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
  const templates = simulator.sends('whatsapp').filter((t) => t.kind === 'template');
  console.log(`  templates sent: ${templates.map((t) => t.detail).join(', ') || '(none)'}`);

  console.log('\n> Reply SHOP after promo (re-enters flow)');
  await simulator.send('whatsapp', threadWa, { text: 'SHOP' });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
