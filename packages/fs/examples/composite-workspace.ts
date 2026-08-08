import { createRuntime, defineAgent } from '@kuralle-agents/core';
import { CompositeFileSystem, InMemoryFs } from '@kuralle-agents/fs';

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

  const agent = defineAgent({
    id: 'composite-workspace',
    model: live.model,
    instructions:
      'You have a read-only /docs mount and a writable /scratch mount via one workspace tool. Use workspace cat/read on /docs and workspace write on /scratch — never invent file contents.',
    // `readOnly: false` alone only unlocks writes for trusted tool/action code via
    // `ctx.fs` — the model still gets a read-only `workspace` tool. `modelWritable: true`
    // is what lets the model itself write, which this smoke asserts. Supplying your own
    // writable tool via `globalTools.workspace` does NOT work: the runtime registers the
    // workspace tool under that exact name and overwrites the entry.
    workspace: { fs: workspaceFs, readOnly: false, modelWritable: true },
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
    if (event.type === 'text-delta') text += event.payload.delta;
    if (event.type === 'tool-call') toolCalls.push(event.payload.toolName);
  }
  await handle;

  // Read the write back through a named failure. Without `modelWritable: true` the model
  // gets a read-only workspace tool, so the write is refused, the model still reports
  // success, and nothing surfaces until this line throws a bare ENOENT with a stack into
  // in-memory-fs. Naming the cause here is the difference between a five-minute fix and
  // an hour of reading the wrong file.
  let summary: string;
  try {
    summary = await workspaceFs.readFile('/scratch/summary.md');
  } catch {
    throw new Error(
      '/scratch/summary.md was never written. The model called the workspace tool and ' +
        'reported success, so the tool it received was read-only: check that the agent ' +
        `sets \`workspace.modelWritable: true\`. Tool calls seen: ${toolCalls.join(', ') || '(none)'}`,
    );
  }
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
