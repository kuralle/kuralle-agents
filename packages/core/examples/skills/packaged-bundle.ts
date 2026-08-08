/**
 * Skills v2, live — mode 3 of 4: packaged directory (`packagedSkillStore`).
 *
 * A packaged skill is a content-addressed bundle of base64 files — the shape
 * `packageSkillsDirectory` (`@kuralle-agents/build`) produces from a real `SKILL.md` folder at
 * build time. This example builds that same shape by hand, in-process, so it stays a
 * `@kuralle-agents/core`-only example (no `@kuralle-agents/build` dependency) while still
 * proving the runtime side: the agent below has **no `workspace` filesystem at all**, yet
 * `load_skill`, `read_skill_resource`, and `ctx.getSkill()` all work from the bundle alone. That
 * is the point of packaging — see `packages/build/examples/packaged-skills-live.ts` for the
 * build-time half (walking a real directory, refusing to package secrets) and the
 * `allowed-tools` enforcement this mode composes with.
 *
 * Run:
 *   set -a; . ./.env; set +a
 *   bun packages/core/examples/skills/packaged-bundle.ts
 */
import { z } from 'zod';
import { xai } from '@ai-sdk/xai';
import {
  brandPackagedSkill,
  createRuntime,
  defineAgent,
  defineTool,
  packagedSkillStore,
  type PackagedSkill,
  type PackagedSkillFile,
} from '../../src/index.js';
import type { StreamPart } from '../../src/types/stream.js';

function file(content: string): PackagedSkillFile {
  return {
    path: '', // overwritten by the caller keying the `files` map
    encoding: 'base64',
    kind: 'text',
    content: Buffer.from(content, 'utf8').toString('base64'),
  };
}

const skillMd = [
  '---',
  'name: refund-limits',
  'description: Per-tier refund limits. Use when asked how much a customer can be refunded.',
  '---',
  '',
  // Points at the tool, not at the file: `limits.json` is the *tool\'s* data source, read
  // through `ctx.getSkill` inside `check_limit`. Telling the model to read it directly would
  // let it answer from `read_skill_resource` alone and never exercise `ctx.getSkill` — which
  // is exactly what this example exists to prove.
  'Call `check_limit` for the tier in question and report the figure it returns.',
  'Do not quote a limit from any other source.',
].join('\n');

const packaged: PackagedSkill = brandPackagedSkill({
  id: 'skill:refund-limits:handbuilt',
  name: 'refund-limits',
  description: 'Per-tier refund limits. Use when asked how much a customer can be refunded.',
  files: {
    'SKILL.md': { ...file(skillMd), path: 'SKILL.md' },
    'limits.json': { ...file(JSON.stringify({ standard: 50, premium: 500 })), path: 'limits.json' },
  },
});

const check_limit = defineTool({
  name: 'check_limit',
  description: 'Read the packaged refund-limit table for a tier via ctx.getSkill.',
  input: z.object({ tier: z.enum(['standard', 'premium']) }),
  execute: async ({ tier }, ctx) => {
    if (!ctx) throw new Error('check_limit needs a tool context to reach its own skill files.');
    const raw = await ctx.getSkill('refund-limits').file('limits.json').text();
    const limits: Record<string, number> = JSON.parse(raw);
    return { tier, limit: limits[tier] };
  },
});

async function main(): Promise<void> {
  const agent = defineAgent({
    id: 'billing',
    model: xai('grok-3'),
    instructions: 'You are a billing assistant. Load the matching skill, then use its tool to look up exact numbers.',
    tools: { check_limit },
    skills: [[packaged]], // packaged bundle — note the agent below sets no `workspace` at all
  });

  const runtime = createRuntime({
    agents: [agent],
    defaultAgentId: 'billing',
    defaultModel: xai('grok-3'),
  });

  const calls: string[] = [];
  const handle = runtime.run({
    sessionId: `live-packaged-skill-${Date.now()}`,
    input: 'What is the refund limit for a premium customer?',
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
  if (!calls.includes('check_limit')) failures.push('ctx.getSkill-backed tool never executed');
  if (!reply.includes('500')) failures.push('reply did not surface the packaged limit (500) for premium');

  if (failures.length > 0) {
    console.error('\nFAILED:');
    for (const f of failures) console.error('  - ' + f);
    process.exit(1);
  }
  console.log('\nPASS — packaged bundle served load_skill and ctx.getSkill with no workspace filesystem.');
}

await main();
