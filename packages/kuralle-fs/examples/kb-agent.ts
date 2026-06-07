import { createRuntime, defineAgent } from '@kuralle-agents/core';
import { createFsTool, InMemoryFs } from '@kuralle-agents/fs';

const docs = {
  '/kb/getting-started.md': `# Getting Started

Welcome to the Kuralle knowledge base.`,
  '/kb/tools/workspace.md': `# Workspace Tool

Use the workspace tool to ls, cat, grep, find, read, write, and edit files.`,
};

async function main() {
  const workspace = new InMemoryFs(docs);
  const agent = defineAgent({
    id: 'kb',
    instructions: 'You explore bundled documentation via the workspace tool.',
    workspace,
  });

  const runtime = createRuntime({
    agents: [agent],
    defaultAgentId: 'kb',
  });

  const tool = createFsTool({ fs: workspace });

  const listed = await tool.execute!({ op: 'ls', path: '/kb' });
  console.log('ls /kb:', JSON.stringify(listed, null, 2));

  const read = await tool.execute!({ op: 'read', path: '/kb/getting-started.md' });
  console.log('read getting-started:', JSON.stringify(read, null, 2));

  const grep = await tool.execute!({ op: 'grep', pattern: 'workspace', path: '/kb' });
  console.log('grep workspace:', JSON.stringify(grep, null, 2));

  void runtime;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
