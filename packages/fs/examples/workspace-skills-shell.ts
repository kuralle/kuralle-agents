#!/usr/bin/env bun
/**
 * Live smoke: an agent with a just-bash WORKSPACE (fs + shell) and SKILL.md
 * SKILLS living on that same filesystem. Runs a REAL model turn (OpenAI) and
 * asserts the model (1) loaded a skill via load_skill and (2) ran a command via
 * the bash tool. "Untested example = broken example."
 *
 * Run:  KURALLE_EXAMPLE_PROVIDER=openai bun run packages/fs/examples/workspace-skills-shell.ts
 * Needs OPENAI_API_KEY in the repo-root .env.
 */
// Bun auto-loads .env from the cwd (run from repo root). No dotenv needed.
import {
  createRuntime,
  defineAgent,
  createFsTool,
  createShellTool,
} from '@kuralle-agents/core';
import type { HarnessStreamPart, TurnHandle } from '@kuralle-agents/core';
import { fsSkillStore } from '@kuralle-agents/fs';
import { virtualShell } from '@kuralle-agents/fs/shell';

async function resolveModel() {
  const key = process.env.OPENAI_API_KEY;
  if (!key) throw new Error('OPENAI_API_KEY required in .env for the live smoke.');
  const { createOpenAI } = await import('@ai-sdk/openai');
  const modelId = process.env.OPENAI_MODEL ?? 'gpt-4o-mini';
  return { model: createOpenAI({ apiKey: key })(modelId), label: `openai:${modelId}` };
}

const GREETER_SKILL = `---
name: greeter
description: Greet the user warmly using their preferred style. Load this before greeting.
---

# Greeter skill

When greeting, always start with the exact phrase "Ahoy there" and then the user's name.
`;

async function collect(handle: TurnHandle): Promise<{ parts: HarnessStreamPart[]; text: string }> {
  const parts: HarnessStreamPart[] = [];
  let text = '';
  for await (const part of handle.events) {
    parts.push(part);
    if (part.type === 'text-delta') text += part.delta;
  }
  const result = await handle;
  return { parts, text: text || result.text };
}

async function main() {
  const { model, label } = await resolveModel();
  console.log(`model: ${label}\n`);

  // One virtual workspace: fs + shell, seeded with a skill and a data file.
  const { fs, shell } = virtualShell({
    initialFiles: {
      '/skills/greeter/SKILL.md': GREETER_SKILL,
      '/data/orders.txt': 'ORD-1\nORD-2\nORD-3\n',
    },
  });

  const agent = defineAgent({
    id: 'workspace-demo',
    model,
    instructions:
      'You are a workspace agent named Ada. You have a bash tool, a workspace file tool, ' +
      'and skills. Before greeting anyone, you MUST call load_skill("greeter") and follow it. ' +
      'To count orders, use the bash tool to run: wc -l < /data/orders.txt. ' +
      'Do exactly what the user asks using these tools.',
    tools: {
      bash: createShellTool({ shell }),
      workspace: createFsTool({ fs, readOnly: true }),
    },
    skills: fsSkillStore(fs),
  });

  const runtime = createRuntime({ agents: [agent], defaultAgentId: 'workspace-demo' });

  const handle = runtime.run({
    input: 'My name is Sam. Greet me using your greeter skill, then tell me how many orders are in the orders file.',
    sessionId: 'smoke-1',
  });
  const { parts, text } = await collect(handle);

  const toolCalls = parts.filter((p) => p.type === 'tool-call') as Array<{ toolName: string }>;
  const calledLoadSkill = toolCalls.some((c) => c.toolName === 'load_skill');
  const calledBash = toolCalls.some((c) => c.toolName === 'bash');
  const bashResult = parts.find(
    (p) => p.type === 'tool-result' && (p as { toolName: string }).toolName === 'bash',
  ) as { result?: { stdout?: string } } | undefined;

  console.log('--- tool calls:', toolCalls.map((c) => c.toolName).join(', ') || '(none)');
  console.log('--- bash stdout:', JSON.stringify(bashResult?.result?.stdout));
  console.log('--- final text:', text, '\n');

  const failures: string[] = [];
  if (!calledLoadSkill) failures.push('model did not call load_skill');
  if (!calledBash) failures.push('model did not call bash');
  if (!(bashResult?.result?.stdout ?? '').includes('3')) failures.push('bash did not return the order count (3)');
  if (!/ahoy there/i.test(text)) failures.push('final reply did not use the greeter skill phrase');

  if (failures.length) {
    console.error('SMOKE FAILED:\n' + failures.map((f) => `  - ${f}`).join('\n'));
    process.exit(1);
  }
  console.log('SMOKE PASSED — skill loaded from fs, bash ran in the virtual shell, skill phrase used.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
