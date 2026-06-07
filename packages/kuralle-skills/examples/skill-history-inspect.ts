/** Inspect what the session actually persists across turns (do loaded skill bodies survive?). */
import { createRuntime, defineAgent, MemoryStore } from '@kuralle-agents/core';
import { defineSkill } from '../src/defineSkill.js';
import { createOpenAI } from '@ai-sdk/openai';

const model = createOpenAI({ apiKey: process.env.OPENAI_API_KEY! })(process.env.OPENAI_MODEL ?? 'gpt-4o-mini');
const skills = [
  defineSkill({ name: 'returns-policy', description: 'Returns/refunds/30-day window.', body: '# Returns\nRefund 5-7 business days to original method. SECRET_MARKER_RETURNS_42.' }),
  defineSkill({ name: 'shipping-info', description: 'Shipping speeds and delays.', body: '# Shipping\nExpress 1-2 days. SECRET_MARKER_SHIP_99.' }),
];
const agent = defineAgent({ id: 'support', model, instructions: 'Load the matching skill, then answer. Reuse skills already loaded.', skills, limits: { maxSteps: 6 } });
const store = new MemoryStore();
const runtime = createRuntime({ agents: [agent], defaultAgentId: 'support', sessionStore: store });
const sid = `inspect-${Date.now()}`;

async function turn(input: string) {
  const h = runtime.run({ sessionId: sid, input });
  const tools: string[] = [];
  let text = '';
  for await (const ev of h.events) {
    if (ev.type === 'tool-call') tools.push(ev.toolName);
    if (ev.type === 'text-delta') text += ev.delta;
  }
  await h;
  return { tools, text };
}

const r1 = await turn('How many days for a refund?');
console.log(`T1 tools=[${r1.tools.join(',')}] :: ${r1.text.slice(0, 120)}`);
const r2 = await turn('And how fast is express shipping?');
console.log(`T2 tools=[${r2.tools.join(',')}] :: ${r2.text.slice(0, 120)}`);
const r3 = await turn('Remind me again: how many days for the refund?');
console.log(`T3 tools=[${r3.tools.join(',')}] :: ${r3.text.slice(0, 160)}`);
console.log(`\nDECISIVE — T3 reloaded? ${r3.tools.includes('load_skill')}. T3 answered "5-7 days" correctly? ${/5-7|5 to 7|five to seven/i.test(r3.text)}`);
console.log(`=> previously-loaded skill accessible across turns WITHOUT reload: ${!r3.tools.includes('load_skill') && /5-7|5 to 7/i.test(r3.text)}`);

const s = await store.get(sid);
const msgs = s?.messages ?? [];
console.log(`\nsession has ${msgs.length} messages. roles + skill-body presence:`);
for (const [i, m] of msgs.entries()) {
  const c = typeof (m as { content?: unknown }).content === 'string'
    ? (m as { content: string }).content
    : JSON.stringify((m as { content?: unknown }).content);
  const hasReturns = /SECRET_MARKER_RETURNS_42/.test(c);
  const hasShip = /SECRET_MARKER_SHIP_99/.test(c);
  console.log(`  [${i}] role=${(m as { role?: string }).role} len=${c.length}${hasReturns ? ' <RETURNS_BODY>' : ''}${hasShip ? ' <SHIP_BODY>' : ''} :: ${c.slice(0, 80).replace(/\n/g, ' ')}`);
}
const anySkillBodyInHistory = msgs.some(m => /SECRET_MARKER_(RETURNS_42|SHIP_99)/.test(JSON.stringify((m as { content?: unknown }).content)));
console.log(`\nloaded skill body present in persisted history: ${anySkillBodyInHistory}`);
process.exit(0);
