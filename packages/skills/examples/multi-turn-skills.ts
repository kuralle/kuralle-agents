/**
 * Multi-turn conversation with a MULTI-skill agent (>3 skills).
 * Checks: (1) skill selection across turns, (2) access to previously-loaded
 * skills (do earlier load_skill results stay in history?), (3) >3 skills,
 * (4) context-window growth (estimated from session history — the framework's
 * TurnUsage/contextUtilization telemetry is currently NOT wired, see notes).
 *   KURALLE_EXAMPLE_PROVIDER=openai bun examples/multi-turn-skills.ts
 */
import { createRuntime, defineAgent, defineTool, MemoryStore } from '@kuralle-agents/core';
import { defineSkill } from '../src/defineSkill.js';
import { z } from 'zod';
import { createOpenAI } from '@ai-sdk/openai';

const key = process.env.OPENAI_API_KEY;
if (!key) throw new Error('OPENAI_API_KEY required');
const model = createOpenAI({ apiKey: key })(process.env.OPENAI_MODEL ?? 'gpt-4o-mini');
const MODEL_WINDOW = 128_000; // gpt-4o-mini

const lookupOrder = defineTool({
  name: 'lookup_order',
  description: 'Order status, items, delivery date for an order id.',
  input: z.object({ orderId: z.string() }),
  execute: async ({ orderId }) => ({ orderId, status: 'delivered', deliveredAt: '2026-05-20', daysSinceDelivery: 19, total: 240 }),
});

// 5 skills (>3) — distinct domains so we can see selection.
const skills = [
  defineSkill({ name: 'returns-policy', description: 'Returns, refunds, exchanges, the 30-day window.', allowedTools: ['lookup_order'],
    body: '# Returns\n1. lookup_order first.\n2. <30 days old → returnable.\n3. Refund 5-7 business days to original method.' }),
  defineSkill({ name: 'shipping-info', description: 'Shipping speeds, delays, tracking, carriers.',
    body: '# Shipping\n- Standard 3-5 business days, Express 1-2.\n- Delays: weather/customs add 2-3 days.\n- Tracking emailed at dispatch.' }),
  defineSkill({ name: 'warranty-claims', description: 'Product warranty length, what is covered, how to claim.', allowedTools: ['lookup_order'],
    body: '# Warranty\n- 12-month limited warranty from delivery.\n- Covers defects, not accidental damage.\n- Claim: lookup_order + describe the fault.' }),
  defineSkill({ name: 'gift-cards', description: 'Gift card balances, expiry, non-returnable rules.',
    body: '# Gift cards\n- Never expire.\n- Non-refundable and non-returnable.\n- Not redeemable for cash.' }),
  defineSkill({ name: 'account-security', description: 'Password resets, 2FA, suspicious login, account lockout.',
    body: '# Account security\n- Reset via emailed link (15-min expiry).\n- Enable 2FA in Settings → Security.\n- Suspicious login → force-logout all sessions.' }),
];

const agent = defineAgent({
  id: 'support',
  model,
  instructions: 'You are a precise support agent. Load the matching skill with load_skill before answering; never guess policy. Reuse a skill already loaded earlier in the conversation instead of reloading it.',
  tools: { lookup_order: lookupOrder },
  skills,
  limits: { maxSteps: 8 },
});

const store = new MemoryStore();
const runtime = createRuntime({ agents: [agent], defaultAgentId: 'support', sessionStore: store });
const sessionId = `multiturn-${Date.now()}`;
const estTokens = (s: unknown) => Math.round(JSON.stringify(s ?? '').length / 4); // ~4 chars/token

async function turn(n: number, input: string) {
  const handle = runtime.run({ sessionId, input });
  const toolCalls: string[] = [];
  let text = '';
  for await (const ev of handle.events) {
    if (ev.type === 'text-delta') text += ev.delta;
    if (ev.type === 'tool-call') toolCalls.push(ev.toolName);
  }
  await handle;
  const session = await store.get(sessionId);
  const ctxTokens = estTokens(session?.messages);
  console.log(`\n=== Turn ${n} =====================================`);
  console.log(`user: ${input}`);
  console.log(`tools: [${toolCalls.join(', ')}]`);
  console.log(`answer: ${text.slice(0, 220)}${text.length > 220 ? '…' : ''}`);
  console.log(`context: ~${ctxTokens} tok est (${((ctxTokens / MODEL_WINDOW) * 100).toFixed(2)}% of ${MODEL_WINDOW} window), ${session?.messages?.length ?? 0} msgs`);
  return { toolCalls, text };
}

console.log(`Multi-turn skills — 5 skills available, session ${sessionId}`);
const t1 = await turn(1, 'Can I return order A123? It arrived a few weeks ago.');
const t2 = await turn(2, 'How long does express shipping take, and what causes delays?');
const t3 = await turn(3, 'Back to that return — remind me how many days the refund takes.'); // reuse returns-policy from T1?
const t4 = await turn(4, 'Is my order still under warranty, and what does it cover?');
const t5 = await turn(5, 'Two things: is a gift card returnable, and how do I turn on 2FA?'); // two skills in one turn

// assertions
const loadedAcross = new Set([...t1.toolCalls, ...t2.toolCalls, ...t3.toolCalls, ...t4.toolCalls, ...t5.toolCalls].filter(t => t === 'load_skill').length ? ['load_skill'] : []);
const t3Reused = !t3.toolCalls.includes('load_skill') && /5-7|5 to 7|business day/i.test(t3.text); // answered refund timing without reloading
const t5MultiSkill = /(gift card).*(2fa|two-factor|settings)/is.test(t5.text) || (/gift card/i.test(t5.text) && /2fa|two-factor|security/i.test(t5.text));
const distinctSkillsLoaded = new Set(
  [t1, t2, t3, t4, t5].flatMap(t => t.toolCalls).filter(t => t === 'load_skill'),
);
console.log('\n=== checks =====================================');
console.log('used load_skill at all:', loadedAcross.length > 0);
console.log('T3 reused prior returns-policy without reloading:', t3Reused, `(tools: ${t3.toolCalls.join(',') || 'none'})`);
console.log('T5 answered across two skills (gift-cards + account-security):', t5MultiSkill);
console.log('NOTE: context numbers are ESTIMATES from session history — the framework\'s TurnUsage/contextUtilization (real model token counts) is currently not wired.');
process.exit(0);
