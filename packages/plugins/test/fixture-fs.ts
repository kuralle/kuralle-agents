import { readFileSync, readdirSync, readlinkSync, lstatSync } from 'node:fs';
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
  return { fs, root };
}
