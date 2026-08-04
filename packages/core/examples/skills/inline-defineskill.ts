/**
 * Skills v2, live — mode 1 of 4: inline `defineSkill`.
 *
 * The simplest supply mode: no filesystem, no build step, no resolver — a skill authored
 * directly in code. Proves the three levels of progressive disclosure actually hold against a
 * real model: the catalog line is what selects the skill, `load_skill` is what returns the
 * body, and `read_skill_resource` is what returns a bundled file the body only *names*.
 *
 * Run:
 *   set -a; . ./.env; set +a
 *   bun packages/core/examples/skills/inline-defineskill.ts
 */
import { z } from 'zod';
import { xai } from '@ai-sdk/xai';
import { createRuntime, defineAgent, defineSkill, defineTool } from '../../src/index.js';
import type { StreamPart } from '../../src/types/stream.js';

const houseStyle = defineSkill({
  name: 'house-style',
  description: 'Edit copy into the house voice. Use when asked to review or rewrite marketing prose.',
  instructions: [
    'Before answering, read `banned-words.md` for the current banned list,',
    'then report exactly which banned words (if any) appear in the draft.',
  ].join('\n'),
  resources: { 'banned-words.md': '# Banned\n- leverage\n- synergy\n- utilize' },
});

const editor = defineAgent({
  id: 'editor',
  model: xai('grok-3'),
  instructions: 'You are a copy editor. Activate the matching skill before doing any editing work.',
  tools: {
    noop: defineTool({
      name: 'noop',
      description: 'Does nothing. Present only so the agent has a tool surface besides skills.',
      input: z.object({}),
      execute: async () => ({ ok: true }),
    }),
  },
  skills: [houseStyle],
});

async function main(): Promise<void> {
  const runtime = createRuntime({
    agents: [editor],
    defaultAgentId: 'editor',
    defaultModel: xai('grok-3'),
  });

  const calls: string[] = [];
  const handle = runtime.run({
    sessionId: `live-inline-skill-${Date.now()}`,
    input: 'Review this draft against the house style: "We utilize best-in-class synergy to leverage growth."',
  });

  let text = '';
  for await (const part of handle.events as AsyncIterable<StreamPart>) {
    if (part.type === 'text-delta') text += part.payload.delta ?? '';
    if (part.type === 'tool-call') calls.push((part.payload as { toolName?: string }).toolName ?? 'unknown');
  }

  const reply = text.trim();
  console.log('--- reply ---\n' + reply + '\n');
  console.log('tool activity:', JSON.stringify(calls));

  const failures: string[] = [];
  if (!calls.includes('load_skill')) failures.push('the model never called load_skill');
  if (!calls.includes('read_skill_resource')) {
    failures.push('the model never called read_skill_resource for banned-words.md');
  }
  for (const word of ['leverage', 'synergy', 'utilize']) {
    if (!reply.toLowerCase().includes(word)) failures.push(`reply did not report banned word "${word}"`);
  }

  if (failures.length > 0) {
    console.error('\nFAILED:');
    for (const f of failures) console.error('  - ' + f);
    process.exit(1);
  }
  console.log('\nPASS — inline defineSkill served all 3 progressive-disclosure levels live.');
}

await main();
