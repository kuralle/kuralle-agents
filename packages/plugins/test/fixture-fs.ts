import { existsSync, readFileSync, readdirSync, readlinkSync, lstatSync } from 'node:fs';
import { join } from 'node:path';
import { InMemoryFs } from '@kuralle-agents/fs';

export interface FixtureFileSystem {
  fs: InMemoryFs;
  root: string;
}

export async function loadFixtureIntoMemoryFs(
  fixtureDir: string,
): Promise<FixtureFileSystem> {
  const fs = new InMemoryFs();
  const root = '/plugin';

  async function walk(diskPath: string, vfsPath: string): Promise<void> {
    const stat = lstatSync(diskPath);

    if (stat.isDirectory()) {
      await fs.mkdir(vfsPath, { recursive: true });
      for (const entry of readdirSync(diskPath, { withFileTypes: true })) {
        await walk(join(diskPath, entry.name), `${vfsPath}/${entry.name}`);
      }
      return;
    }

    if (stat.isFile()) {
      const parent = vfsPath.slice(0, vfsPath.lastIndexOf('/')) || '/';
      await fs.mkdir(parent, { recursive: true });
      await fs.writeFile(vfsPath, readFileSync(diskPath, 'utf8'));
      return;
    }

    if (stat.isSymbolicLink()) {
      const parent = vfsPath.slice(0, vfsPath.lastIndexOf('/')) || '/';
      await fs.mkdir(parent, { recursive: true });
      await fs.symlink(readlinkSync(diskPath), vfsPath);
      return;
    }

    throw new Error(`Cannot classify fixture entry: ${diskPath}`);
  }

  await walk(fixtureDir, root);

  // A sibling `outside/` directory mounts at `/outside`, next to the plugin root rather
  // than inside it. That is what lets a fixture express "a symlink whose target exists but
  // is outside the plugin root" — §4.1(3)'s actual case. Without it an escaping symlink is
  // indistinguishable from a missing file, and the fixture proves nothing.
  const outsideDir = join(fixtureDir, '..', 'outside');
  if (existsSync(outsideDir)) {
    await walk(outsideDir, '/outside');
  }

  return { fs, root };
}
