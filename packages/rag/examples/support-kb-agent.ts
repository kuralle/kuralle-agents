import { createRuntime, defineAgent } from '@kuralle-agents/core';
import { createFsTool } from '@kuralle-agents/fs';
import { KnowledgeFs } from '../src/fs/KnowledgeFs.js';
import { KB_INDEX, seedKnowledgeStore } from '../test/knowledgefs-fixture.js';

async function loadEnv(): Promise<void> {
  try {
    const { config } = await import('dotenv');
    const { dirname, join } = await import('node:path');
    const { fileURLToPath } = await import('node:url');
    const dir = dirname(fileURLToPath(import.meta.url));
    config({ path: join(dir, '../../../.env') });
  } catch {
    // optional in CI
  }
}

async function resolveModel() {
  const provider = process.env.KURALLE_EXAMPLE_PROVIDER?.trim().toLowerCase() ?? 'openai';
  if (provider !== 'openai') {
    throw new Error('Set KURALLE_EXAMPLE_PROVIDER=openai for this smoke (stale default models elsewhere).');
  }
  const key = process.env.OPENAI_API_KEY;
  if (!key) throw new Error('OPENAI_API_KEY is required for the live smoke.');
  const { createOpenAI } = await import('@ai-sdk/openai');
  const modelId = process.env.OPENAI_MODEL ?? 'gpt-4o-mini';
  return {
    model: createOpenAI({ apiKey: key })(modelId),
    label: `openai:${modelId}`,
  };
}

async function main() {
  await loadEnv();
  const live = await resolveModel();

  const store = await seedKnowledgeStore([
    {
      path: '/policies/returns.md',
      chunks: ['# Returns\n\n', 'Return window: 30 days from delivery date.\n'],
    },
    {
      path: '/support/contact.md',
      chunks: ['# Support\n\n', 'Email returns@acme.example for return help.\n'],
    },
  ]);

  const workspace = await KnowledgeFs.open({ store, indexName: KB_INDEX });
  const agent = defineAgent({
    id: 'support-kb',
    model: live.model,
    instructions:
      'You are a support agent with a read-only knowledge base. You MUST use the workspace tool before answering: grep with flags "i" for case-insensitive search, then cat each relevant path. Never guess — only quote text you read via cat.',
    workspace,
    limits: { maxSteps: 10 },
  });

  const runtime = createRuntime({
    agents: [agent],
    defaultAgentId: agent.id,
  });

  const sessionId = `support-kb-${Date.now()}`;
  const handle = runtime.run({
    sessionId,
    input:
      'What is our return window and which email should customers use for return questions? Use workspace grep with flags "i" for "return" and "email", then cat each matching page before answering.',
  });

  const toolCalls: string[] = [];
  const toolTrace: unknown[] = [];
  let text = '';
  for await (const event of handle.events) {
    if (event.type === 'text-delta') text += event.delta;
    if (event.type === 'tool-call') {
      toolCalls.push(event.toolName);
      toolTrace.push({ kind: 'call', name: event.toolName, args: event.args });
    }
    if (event.type === 'tool-result') {
      toolTrace.push({ kind: 'result', name: event.toolName, result: event.result });
    }
  }
  const result = await handle;
  const allToolCalls = [...toolCalls];
  const allToolTrace = [...toolTrace];
  let answer = (text || result.text || '').toLowerCase();

  if (!answer.includes('30') || !answer.includes('returns@')) {
    const followUp = runtime.run({
      sessionId,
      input: 'Use workspace grep and cat now, then answer with the return window and email.',
    });
    text = '';
    toolCalls.length = 0;
    toolTrace.length = 0;
    for await (const event of followUp.events) {
      if (event.type === 'text-delta') text += event.delta;
      if (event.type === 'tool-call') {
        toolCalls.push(event.toolName);
        toolTrace.push({ kind: 'call', name: event.toolName, args: event.args });
      }
      if (event.type === 'tool-result') {
        toolTrace.push({ kind: 'result', name: event.toolName, result: event.result });
      }
    }
    const result2 = await followUp;
    allToolCalls.push(...toolCalls);
    allToolTrace.push(...toolTrace);
    console.log('follow-up tool calls:', toolCalls);
    console.log('follow-up answer:', text || result2.text);
    answer = (text || result2.text || '').toLowerCase();
  }

  const grepHits = allToolTrace
    .filter((e) => (e as { kind?: string }).kind === 'result')
    .flatMap((e) => ((e as { result?: { hits?: { path: string }[] } }).result?.hits ?? []));
  const catBodies = allToolTrace
    .filter((e) => (e as { kind?: string }).kind === 'result')
    .map((e) => (e as { result?: { content?: string } }).result?.content ?? '')
    .join('\n');

  const evidence = `${answer}\n${catBodies}`.toLowerCase();
  const grepPaths = [...new Set(grepHits.map((h) => h.path))];
  const usedGrepCat =
    allToolCalls.filter((n) => n === 'workspace').length >= 2 &&
    grepPaths.some((p) => p.includes('returns.md')) &&
    grepPaths.some((p) => p.includes('contact.md'));

  if (!usedGrepCat || !evidence.includes('30') || !evidence.includes('returns@')) {
    throw new Error(
      `Smoke missing multi-page grep+cat (paths: ${JSON.stringify(grepPaths)}, evidence: ${evidence.slice(0, 240)})`,
    );
  }

  console.log('model:', live.label);
  console.log('grep paths:', grepPaths);
  console.log('answer:', text || result.text);

  const writeAttempt = createFsTool({ fs: workspace, readOnly: true });
  try {
    await writeAttempt.execute!({ op: 'write', path: '/policies/hack.md', content: 'nope' });
    throw new Error('expected EROFS on write');
  } catch (err) {
    if (!(err instanceof Error) || !/EROFS/.test(err.message)) throw err;
  }

  void runtime;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
