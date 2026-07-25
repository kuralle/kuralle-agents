#!/usr/bin/env bun
/**
 * OKF's central claim is that it needs no tooling: "If you can `cat` a file, you can
 * read OKF." This example tests that literally — the sales bundle is mounted into a
 * just-bash virtual filesystem and the agent is given a *real POSIX shell*, not our
 * `workspace` tool. No OKF parser, no adapter, no frontmatter library: grep and cat.
 *
 * The contrast with `okf-knowledge-agent.ts` is the point. That one navigates via the
 * structured `workspace` tool. This one proves the same bundle answers the same
 * question through pipes and `grep -r`, which is what a human would reach for.
 *
 * `virtualShell()` returns { fs, shell } over one JustBashFs, so the shell and the
 * FileSystem are the same tree — a file written by the agent is visible to `cat`.
 *
 * Run: KURALLE_EXAMPLE_PROVIDER=openai bun run packages/fs/examples/okf-over-bash.ts
 * Spec: https://github.com/GoogleCloudPlatform/knowledge-catalog/tree/main/okf
 */
import { createRuntime, defineAgent, createShellTool } from '@kuralle-agents/core';
import type { StreamPart, TurnHandle } from '@kuralle-agents/core';
import { virtualShell } from '@kuralle-agents/fs/shell';
import { listOkfConcepts } from '@kuralle-agents/fs';
import { SALES_BUNDLE } from './_okf-bundle.js';

// Matches the resolver in workspace-skills-shell.ts — same directory, same convention.
async function resolveModel() {
  const key = process.env.OPENAI_API_KEY;
  if (!key) return undefined;
  const { createOpenAI } = await import('@ai-sdk/openai');
  const modelId = process.env.OPENAI_MODEL ?? 'gpt-4o-mini';
  return createOpenAI({ apiKey: key })(modelId);
}

const INSTRUCTIONS = `You answer data questions from an Open Knowledge Format (OKF)
bundle mounted at / in your shell. It is markdown files with YAML frontmatter that
cross-link with bundle-relative paths.

Procedure — use the \`bash\` tool only:
1. \`cat /index.md\` to see what exists (progressive disclosure).
2. \`grep -rl "<term>" /\` to locate concepts by term.
3. \`cat <path>\` to read a concept; follow its markdown links.

Answer from the bundle only. Quote the concept path you used.`;

async function collect(handle: TurnHandle): Promise<{ text: string; parts: StreamPart[] }> {
  const parts: StreamPart[] = [];
  let text = '';
  for await (const part of handle.events) {
    parts.push(part);
    if (part.type === 'text-delta') text += part.payload.delta;
  }
  return { text, parts };
}

async function main(): Promise<void> {
  // The whole mount: an OKF bundle is a Record<path, markdown>, which is exactly
  // what just-bash seeds from. Nothing OKF-aware happens here.
  const { fs, shell } = virtualShell({ initialFiles: SALES_BUNDLE });

  // Sanity: the same tree is readable both ways before the model sees it.
  const viaShell = await shell.exec('ls /tables');
  const viaFs = await fs.readdir('/tables');
  console.log('shell ls /tables :', viaShell.stdout.trim().split('\n').join(' '));
  console.log('fs.readdir       :', viaFs.join(' '));

  // The structured reader still works over the same mount — parser and shell agree.
  const concepts = await listOkfConcepts(fs, '/');
  console.log(`listOkfConcepts  : ${concepts.length} concepts, types:`,
    [...new Set(concepts.map((c) => c.type))].join(', '));

  const grep = await shell.exec('grep -rl "weekly_active_users" / || true');
  console.log('grep -rl WAU     :', grep.stdout.trim().split('\n').join(' ') || '(none)');

  const model = await resolveModel();
  if (!model) {
    console.log('\nOPENAI_API_KEY not set — skipping the live turn. Mount verified above.');
    return;
  }

  const runtime = createRuntime({
    agents: [
      defineAgent({
        id: 'okf-bash',
        model,
        instructions: INSTRUCTIONS,
        tools: { bash: createShellTool({ shell }) },
      }),
    ],
    defaultAgentId: 'okf-bash',
  });

  const { text, parts } = await collect(
    runtime.run({ input: 'How is Weekly Active Users defined, and which table does it come from?', sessionId: 'okf-bash-1' }),
  );

  const calls = parts.filter((p) => p.type === 'tool-call').map((p) => p.payload);
  console.log('\n--- bash calls:', calls.length);
  console.log('--- answer:', text.replace(/\s+/g, ' ').trim());

  const failures: string[] = [];
  if (calls.length === 0) failures.push('agent never ran a shell command');
  if (!/weekly[_ ]active/i.test(text)) failures.push('answer does not mention WAU');
  if (!/events/i.test(text)) failures.push('answer does not name the source table');
  if (failures.length > 0) {
    console.error('\nFAIL:', failures.join('; '));
    process.exit(1);
  }
  console.log('\nPASS: an OKF bundle answered a real question through nothing but bash.');
}

await main();
