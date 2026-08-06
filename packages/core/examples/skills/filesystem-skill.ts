/**
 * Skills v2, live — mode 2 of 4: filesystem path (`fsSkillStore`).
 *
 * Skills as `SKILL.md` folders on a workspace filesystem, discovered from the default root
 * `/.agents/skills`. Proves discovery works with no explicit roots argument, and that a skill is
 * hot-updatable: editing the file on the fs and starting a fresh session serves the new content
 * with no rebuild or redeploy — the filesystem is the source of truth, not a compiled snapshot.
 *
 * Run:
 *   set -a; . ./.env; set +a
 *   bun packages/core/examples/skills/filesystem-skill.ts
 */
import { xai } from '@ai-sdk/xai';
import { InMemoryFs } from '@kuralle-agents/fs';
import { createRuntime, defineAgent, fsSkillStore } from '../../src/index.js';
import type { StreamPart } from '../../src/types/stream.js';

const SKILL_PATH = '/.agents/skills/on-call/SKILL.md';

function skillMd(escalationContact: string): string {
  return [
    '---',
    'name: on-call',
    'description: Who to escalate a production incident to. Use when asked who is on call.',
    '---',
    '',
    `The current on-call contact is ${escalationContact}. State that exact name, nothing else.`,
  ].join('\n');
}

async function askOnCall(fs: InMemoryFs, sessionId: string): Promise<string> {
  const agent = defineAgent({
    id: 'ops',
    model: xai('grok-3'),
    instructions: 'You are an ops assistant. Load the matching skill before answering.',
    workspace: fs,
    skills: fsSkillStore(fs), // no roots argument — scans the default /.agents/skills
  });
  const runtime = createRuntime({
    agents: [agent],
    defaultAgentId: 'ops',
    defaultModel: xai('grok-3'),
  });
  const handle = runtime.run({ sessionId, input: 'Who is on call right now?' });
  let text = '';
  for await (const part of handle.events as AsyncIterable<StreamPart>) {
    if (part.type === 'text-delta') text += part.payload.delta ?? '';
  }
  return text.trim();
}

async function main(): Promise<void> {
  const fs = new InMemoryFs({ [SKILL_PATH]: skillMd('Priya') });

  const first = await askOnCall(fs, `live-fs-skill-a-${Date.now()}`);
  console.log('--- turn 1 (Priya) ---\n' + first + '\n');

  // Hot update: edit the file on disk, no rebuild, no redeploy.
  await fs.writeFile(SKILL_PATH, skillMd('Devon'));

  const second = await askOnCall(fs, `live-fs-skill-b-${Date.now()}`);
  console.log('--- turn 2, after edit (Devon) ---\n' + second + '\n');

  const failures: string[] = [];
  if (!first.includes('Priya')) failures.push('first session did not serve the original SKILL.md content');
  if (!second.includes('Devon')) failures.push('second session did not serve the hot-updated SKILL.md content');
  if (second.includes('Priya')) failures.push('second session served stale content after the edit');

  if (failures.length > 0) {
    console.error('FAILED:');
    for (const f of failures) console.error('  - ' + f);
    process.exit(1);
  }
  console.log('PASS — default-root discovery and hot-update both held live.');
}

await main();
