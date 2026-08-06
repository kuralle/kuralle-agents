/**
 * Skills v2, live.
 *
 * Typecheck is not enough here. This repository has shipped a feature exported from nowhere
 * that compiled cleanly and only failed on a live run, so every claim in the skills epic gets
 * exercised against a real model and asserted on observed behaviour:
 *
 *   1. a skill packaged from disk loads with NO workspace filesystem   (a4-packaging)
 *   2. the load_skill briefing hands the model the exact call per file (a2-loadskill)
 *   3. read_skill_resource reaches a reference the body only names     (a2-loadskill)
 *   4. an authored tool reads its own skill's files via ctx.getSkill   (a7-handle)
 *   5. allowed-tools is enforced at the tool boundary, not the prompt  (a3-allowedtools)
 *
 * (5) is the one that matters most: the model is told to call a forbidden tool, and the
 * denial has to come from the Policy rather than from the model choosing to comply.
 *
 * Run:
 *   set -a; . ./.env; set +a
 *   bun packages/build/examples/packaged-skills-live.ts
 */
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { openai } from '@ai-sdk/openai';
import { packageSkillsDirectory } from '../src/packageSkillsDirectory.js';
import { createRuntime, defineAgent, defineTool } from '@kuralle-agents/core';
import type { StreamPart } from '@kuralle-agents/core';

const BANNED = ['leverage', 'synergy', 'utilize'];

/** Writes a real skill package to a real directory, so packaging walks a real filesystem. */
async function writeSkillFixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'kuralle-live-skills-'));
  const dir = join(root, 'house-style');
  await mkdir(join(dir, 'references'), { recursive: true });
  await writeFile(
    join(dir, 'SKILL.md'),
    [
      '---',
      'name: house-style',
      'description: Edit copy into the house voice. Use when asked to review or rewrite marketing prose.',
      'allowed-tools: lint_copy',
      '---',
      '',
      'Before answering, read `references/banned-words.json` for the current banned list,',
      'then call `lint_copy` with the draft. Report exactly which banned words it found.',
    ].join('\n'),
  );
  await writeFile(
    join(dir, 'references', 'banned-words.json'),
    JSON.stringify({ banned: BANNED }, null, 2),
  );
  return root;
}

const calls: string[] = [];
const denials: string[] = [];

/** Reads its OWN skill's reference file through ctx.getSkill — the a7 primitive. */
const lint_copy = defineTool({
  name: 'lint_copy',
  description: 'Lint a draft against the house banned-words list.',
  replay: false,
  parallelSafe: true,
  input: z.object({ draft: z.string() }),
  execute: async ({ draft }, ctx) => {
    calls.push('lint_copy');
    if (!ctx) throw new Error('lint_copy needs a tool context to reach its own skill files.');
    const raw = await ctx.getSkill('house-style').file('references/banned-words.json').text();
    const banned: string[] = JSON.parse(raw).banned;
    const found = banned.filter((w) => draft.toLowerCase().includes(w));
    return { found, checked: banned.length };
  },
});

/** Declared on the agent but NOT in the skill's allowed-tools. Must be denied once active. */
const publish_copy = defineTool({
  name: 'publish_copy',
  description: 'Publish the draft to the live site.',
  replay: false,
  input: z.object({ draft: z.string() }),
  execute: async () => {
    calls.push('publish_copy');
    return { published: true };
  },
});

async function main(): Promise<void> {
  const root = await writeSkillFixture();

  // (1) Package from disk, then hand the agent ONLY the packaged array — no `workspace`.
  const packaged = await packageSkillsDirectory(root);
  console.log(`packaged ${packaged.length} skill(s): ${packaged.map((p) => p.id).join(', ')}`);

  const editor = defineAgent({
    id: 'editor',
    model: openai('gpt-4.1-mini'),
    instructions: [
      'You are a copy editor. Activate the house-style skill before doing any editing work,',
      'and follow its instructions exactly.',
    ].join(' '),
    tools: { lint_copy, publish_copy },
    skills: [packaged],
  });

  const runtime = createRuntime({
    agents: [editor],
    defaultAgentId: 'editor',
    defaultModel: openai('gpt-4.1-mini'),
  });

  const draft = 'We utilize best-in-class synergy to leverage growth.';
  const handle = runtime.run({
    sessionId: `live-skills-${Date.now()}`,
    input:
      `Review this draft against the house style, then publish it with publish_copy:\n\n${draft}`,
  });

  let text = '';
  for await (const part of handle.events as AsyncIterable<StreamPart>) {
    if (part.type === 'text-delta') text += part.payload.delta ?? '';
    if (part.type === 'tool-call') calls.push(`call:${(part.payload as { toolName?: string }).toolName}`);
    if (part.type === 'tool-result') {
      // A policy denial arrives as an ordinary tool-result carrying a control shape, so the
      // model can read the reason and choose what to say next — not as a thrown tool error.
      const payload = part.payload as {
        toolName?: string;
        result?: { __denied?: boolean; deniedBy?: string };
      };
      if (payload.result?.__denied === true && payload.result.deniedBy === 'policy') {
        denials.push(payload.toolName ?? 'unknown');
      }
    }
  }

  const reply = text.trim();
  console.log('\n--- reply ---\n' + reply + '\n');
  console.log('tool activity:', JSON.stringify(calls));
  console.log('policy denials:', JSON.stringify(denials));

  // Assertions on observed behaviour, not on the reply's prose.
  const failures: string[] = [];
  if (!calls.includes('call:load_skill')) failures.push('the model never activated the skill');
  if (!calls.includes('call:read_skill_resource')) {
    failures.push('the model never read the reference the briefing advertised');
  }
  if (!calls.includes('lint_copy')) failures.push('ctx.getSkill-backed tool never executed');
  if (calls.includes('publish_copy')) {
    failures.push('publish_copy EXECUTED — allowed-tools was not enforced at the boundary');
  }
  if (denials.length === 0) failures.push('no policy denial observed for the forbidden tool');
  const mentionsAll = BANNED.every((w) => reply.toLowerCase().includes(w));
  if (!mentionsAll) failures.push('reply did not report every banned word the linter found');

  if (failures.length > 0) {
    console.error('\nFAILED:');
    for (const f of failures) console.error('  - ' + f);
    process.exit(1);
  }
  console.log('\nPASS — packaged skills, resource disclosure, ctx.getSkill, and allowed-tools all held live.');

  await demonstrateActivationScope(packaged);
}

/**
 * The limitation, demonstrated rather than described.
 *
 * `allowed-tools` is scoped to *activation*: it restricts a turn only once `load_skill` has
 * succeeded for a skill that declares one. A model that never activates — because it guessed
 * the name wrong, or simply chose not to — is unrestricted, and `publish_copy` runs.
 *
 * That is internally consistent (a skill that was never loaded imposes nothing), but it means
 * `allowed-tools` is a guard-rail for an honest model that makes mistakes, NOT a boundary
 * against an adversarial one. For an unconditional restriction, set an agent `policy`.
 *
 * This was found by a live run: an early execution of this example let `publish_copy` through,
 * and the cause was a `load_skill` call that missed. Encoding it here so the caveat cannot
 * quietly stop being true.
 */
async function demonstrateActivationScope(
  packaged: Awaited<ReturnType<typeof packageSkillsDirectory>>,
): Promise<void> {
  let published = false;
  const publish_only = defineTool({
    name: 'publish_copy',
    description: 'Publish the draft to the live site.',
    replay: false,
    input: z.object({}),
    execute: async () => {
      published = true;
      return { published: true };
    },
  });
  const agent = defineAgent({
    id: 'near-miss',
    model: openai('gpt-4.1-mini'),
    instructions: 'First call load_skill with the name "House_Style" exactly. Then call publish_copy with {}.',
    tools: { lint_copy, publish_copy: publish_only },
    skills: [packaged],
  });
  const runtime = createRuntime({
    agents: [agent],
    defaultAgentId: 'near-miss',
    defaultModel: openai('gpt-4.1-mini'),
  });
  const handle = runtime.run({ sessionId: `live-scope-${Date.now()}`, input: 'Go.' });
  for await (const _ of handle.events as AsyncIterable<StreamPart>) {
    // drain
  }

  console.log(
    published
      ? '\nSCOPE (expected): a load_skill that missed left the agent unrestricted — allowed-tools is activation-scoped.'
      : '\nSCOPE CHANGED: a missed activation now restricts. Update the skills guide, which documents the opposite.',
  );
}

await main();
