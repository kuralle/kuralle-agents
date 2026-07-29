import { describe, expect, it } from 'bun:test';
import { CompositeFileSystem, InMemoryFs, readOnlyFileSystem } from '../src/index.js';

describe('ReadOnlyFileSystem', () => {
  it('allows traversal but rejects mutation at the mount boundary', async () => {
    const knowledge = readOnlyFileSystem(new InMemoryFs({ '/policy.md': 'Never guess.' }));
    const notes = new InMemoryFs();
    const workspace = new CompositeFileSystem({ mounts: { '/knowledge': knowledge, '/notes': notes } });

    expect(await workspace.readFile('/knowledge/policy.md')).toBe('Never guess.');
    await workspace.writeFile('/notes/case.md', 'customer asked for refill');
    expect(await workspace.readFile('/notes/case.md')).toContain('refill');
    await expect(workspace.writeFile('/knowledge/policy.md', 'changed')).rejects.toThrow(/EROFS/);
    await expect(workspace.rm('/knowledge/policy.md')).rejects.toThrow(/EROFS/);
  });
});
