import { CompositeFileSystem, InMemoryFs, createFsTool } from '../src/index.js';

const docs = new InMemoryFs({ '/readme.md': 'workers composite ok' });
const scratch = new InMemoryFs();
const fs = new CompositeFileSystem({
  mounts: { '/docs': docs, '/scratch': scratch },
});
const tool = createFsTool({ fs, readOnly: false });

export async function runCompositeWorkspaceRoundTrip(): Promise<{
  readContent: string;
  scratchContent: string;
}> {
  const read = await tool.execute!({ op: 'read', path: '/docs/readme.md' });
  await tool.execute!({
    op: 'write',
    path: '/scratch/note.md',
    content: 'written in workerd',
  });
  const scratchRead = await fs.readFile('/scratch/note.md');
  return {
    readContent: (read as { content: string }).content,
    scratchContent: scratchRead,
  };
}

export const COMPOSITE_READ_CONTENT = 'workers composite ok';
export const COMPOSITE_SCRATCH_CONTENT = 'written in workerd';
