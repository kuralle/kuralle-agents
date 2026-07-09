import { InMemoryFs, createFsTool } from '../src/index.js';

const fs = new InMemoryFs({ '/docs/readme.md': 'workers ok' });
const tool = createFsTool({ fs });

export async function runWorkspaceRoundTrip(): Promise<{ content: string }> {
  const result = await tool.execute!({ op: 'read', path: '/docs/readme.md' });
  return { content: (result as { content: string }).content };
}

export const NODE_WORKSPACE_CONTENT = 'workers ok';
