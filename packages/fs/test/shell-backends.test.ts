import { describe, expect, it } from 'bun:test';
import { bashShell, virtualShell } from '../src/shell.js';
import { nodeShell } from '../src/node/node-shell.js';

describe('test:shell-backends — virtualShell (just-bash)', () => {
  it('runs echo and returns stdout + exitCode 0', async () => {
    const { shell } = virtualShell();
    const result = await shell.exec('echo hi');
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe('hi');
  });

  it('returns a nonzero exitCode for a failing command', async () => {
    const { shell } = virtualShell();
    const result = await shell.exec('false');
    expect(result.exitCode).not.toBe(0);
  });

  it('the adapter fs round-trips a file the shell can cat', async () => {
    const { fs, shell } = virtualShell();
    await fs.writeFile('/note.txt', 'from-fs');
    const viaFs = await fs.readFile('/note.txt');
    expect(viaFs).toBe('from-fs');
    const viaShell = await shell.exec('cat /note.txt');
    expect(viaShell.stdout.trim()).toBe('from-fs');
  });

  it('seeds initialFiles into the virtual fs', async () => {
    const { shell } = virtualShell({ initialFiles: { '/seed.txt': 'seeded' } });
    const result = await shell.exec('cat /seed.txt');
    expect(result.stdout.trim()).toBe('seeded');
  });

  it('the adapter fs exposes glob over the virtual tree', async () => {
    const { fs } = virtualShell({
      initialFiles: { '/a.md': '1', '/b.md': '2', '/c.txt': '3' },
    });
    const md = await fs.glob('/*.md');
    expect(md.sort()).toEqual(['/a.md', '/b.md']);
  });
});

describe('test:shell-backends — bashShell abort', () => {
  it('throws AbortError when the caller signal is already aborted', async () => {
    const fakeBash = {
      exec: async () => ({ stdout: 'should-not-run', stderr: '', exitCode: 0 }),
      getCwd: () => '/',
      fs: {},
    };
    const shell = bashShell(fakeBash);
    const controller = new AbortController();
    controller.abort();
    await expect(shell.exec('echo hi', { signal: controller.signal })).rejects.toThrow();
  });
});

describe('test:shell-backends — nodeShell (host)', () => {
  it('runs echo on the host', async () => {
    const shell = nodeShell();
    const result = await shell.exec('echo hi');
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe('hi');
  });

  it('does not inherit a non-allowlisted host env var unless passed', async () => {
    process.env.KURALLE_SECRET_TEST = 'leaked';
    try {
      const shell = nodeShell();
      const blocked = await shell.exec('printf "%s" "$KURALLE_SECRET_TEST"');
      expect(blocked.stdout).toBe('');
      const passed = await shell.exec('printf "%s" "$KURALLE_SECRET_TEST"', {
        env: { KURALLE_SECRET_TEST: 'explicit' },
      });
      expect(passed.stdout).toBe('explicit');
    } finally {
      delete process.env.KURALLE_SECRET_TEST;
    }
  });
});
