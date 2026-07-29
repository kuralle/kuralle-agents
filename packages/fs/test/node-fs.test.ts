import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { nodeFileSystem } from '../src/node/node-fs.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function makeFs() {
  const root = await mkdtemp(join(tmpdir(), 'kuralle-node-fs-'));
  roots.push(root);
  return { root, fs: nodeFileSystem(root) };
}

describe('NodeFileSystem', () => {
  it('persists virtual paths as real local files', async () => {
    const { root, fs } = await makeFs();
    await fs.mkdir('/drafts', { recursive: true });
    await fs.writeFile('/drafts/launch.md', '# Launch\n');

    expect(await fs.readFile('/drafts/launch.md')).toBe('# Launch\n');
    expect(await Bun.file(join(root, 'drafts/launch.md')).text()).toBe('# Launch\n');
  });

  it('supports internal symlinks and rejects symlink escapes', async () => {
    const { root, fs } = await makeFs();
    await fs.writeFile('/target.md', 'inside');
    await fs.symlink('/target.md', '/inside.md');
    expect(await fs.readFile('/inside.md')).toBe('inside');
    expect(await fs.realpath('/inside.md')).toBe('/target.md');

    const outside = await mkdtemp(join(tmpdir(), 'kuralle-node-fs-outside-'));
    roots.push(outside);
    await writeFile(join(outside, 'secret.md'), 'secret');
    await symlink(join(outside, 'secret.md'), join(root, 'escape.md'));

    await expect(fs.readFile('/escape.md')).rejects.toThrow(/EACCES/);
    await expect(fs.writeFile('/escape.md', 'overwritten')).rejects.toThrow(/EACCES/);
    expect(await Bun.file(join(outside, 'secret.md')).text()).toBe('secret');
    expect(await fs.exists('/escape.md')).toBe(false);
  });

  it('rejects traversal and deletion of the configured root', async () => {
    const { fs } = await makeFs();
    await expect(fs.writeFile('/../escape.md', 'no')).rejects.toThrow();
    await expect(fs.rm('/', { recursive: true })).rejects.toThrow(/EBUSY/);
  });
});
