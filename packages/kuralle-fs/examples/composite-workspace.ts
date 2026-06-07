import { createRuntime, defineAgent } from '@kuralle-agents/core';
import { CompositeFileSystem, InMemoryFs, createFsTool } from '@kuralle-agents/fs';

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
    throw new Error('Set KURALLE_EXAMPLE_PROVIDER=openai for this smoke.');
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

function readOnlyMount(fs: InMemoryFs): InMemoryFs & { readOnly: true } {
  return Object.assign(fs, { readOnly: true as const });
}

async function main() {
  await loadEnv();
  const live = await resolveModel();

  const bundled = {
    '/handbook.md': '# Handbook\n\nShip features with tests and proof.',
  };
  const workspaceFs = new CompositeFileSystem({
    mounts: {
      '/docs': readOnlyMount(new InMemoryFs(bundled)),
      '/scratch': new InMemoryFs(),
    },
  });

  const workspaceTool = createFsTool({ fs: workspaceFs, readOnly: false });
  const agent = defineAgent({
    id: 'composite-workspace',
    model: live.model,
    instructions:
      'You have a read-only /docs mount and a writable /scratch mount via one workspace tool. Use workspace cat/read on /docs and workspace write on /scratch — never invent file contents.',
    workspace: { fs: workspaceFs, readOnly: false },
    globalTools: { workspace: workspaceTool },
    limits: { maxSteps: 8 },
  });

  const runtime = createRuntime({
    agents: [agent],
    defaultAgentId: agent.id,
  });

  const sessionId = `composite-workspace-${Date.now()}`;
  const handle = runtime.run({
    sessionId,
    input:
      'Cat /docs/handbook.md, then write a one-line summary of it to /scratch/summary.md using the workspace tool.',
  });

  const toolCalls: string[] = [];
  let text = '';
  for await (const event of handle.events) {
    if (event.type === 'text-delta') text += event.delta;
    if (event.type === 'tool-call') toolCalls.push(event.toolName);
  }
  await handle;

  const summary = await workspaceFs.readFile('/scratch/summary.md');
  const handbook = await workspaceFs.readFile('/docs/handbook.md');

  console.log('model:', live.label);
  console.log('tool calls:', toolCalls);
  console.log('handbook:', handbook);
  console.log('scratch summary:', summary);
  console.log('answer:', text);

  if (!toolCalls.includes('workspace')) {
    throw new Error(`Smoke expected workspace tool calls (got: ${toolCalls.join(', ')})`);
  }
  if (!summary.toLowerCase().includes('test') && !summary.toLowerCase().includes('proof')) {
    throw new Error(`Scratch summary does not reflect handbook: ${summary}`);
  }

  void runtime;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
