import { describe, expect, it } from 'bun:test';
import { InMemoryFs } from '@kuralle-agents/fs';
import { createShellTool } from '../src/tools/fs/createShellTool.js';
import { MAX_SHELL_OUTPUT_BYTES } from '../src/tools/fs/caps.js';
import { resolveAgentWorkspace } from '../src/runtime/resolveAgentWorkspace.js';
import type { Shell, ShellExecOptions, ShellResult } from '../src/types/shell.js';

class FakeShell implements Shell {
  readonly calls: Array<{ command: string; options?: ShellExecOptions }> = [];
  private readonly handler: (
    command: string,
    options?: ShellExecOptions,
  ) => Promise<ShellResult>;

  constructor(
    handler: (command: string, options?: ShellExecOptions) => Promise<ShellResult>,
  ) {
    this.handler = handler;
  }

  async exec(command: string, options?: ShellExecOptions): Promise<ShellResult> {
    this.calls.push({ command, options });
    return this.handler(command, options);
  }
}

describe('createShellTool', () => {
  it('returns a tool named bash with replay false', () => {
    const shell = new FakeShell(async () => ({ stdout: '', stderr: '', exitCode: 0 }));
    const tool = createShellTool({ shell });
    expect(tool.name).toBe('bash');
    expect(tool.replay).toBe(false);
  });

  it('returns ok:true with stdout, stderr, and exitCode 0 on success', async () => {
    const shell = new FakeShell(async () => ({
      stdout: 'hello\n',
      stderr: '',
      exitCode: 0,
    }));
    const tool = createShellTool({ shell });
    const result = await tool.execute!({ command: 'echo hello' });
    expect(result).toEqual({
      op: 'bash',
      ok: true,
      stdout: 'hello\n',
      stderr: '',
      exitCode: 0,
    });
    expect(shell.calls).toHaveLength(1);
    expect(shell.calls[0]?.command).toBe('echo hello');
  });

  it('returns ok:false with the nonzero exitCode', async () => {
    const shell = new FakeShell(async () => ({
      stdout: '',
      stderr: 'fail',
      exitCode: 2,
    }));
    const tool = createShellTool({ shell });
    const result = await tool.execute!({ command: 'false' });
    expect(result).toEqual({
      op: 'bash',
      ok: false,
      stdout: '',
      stderr: 'fail',
      exitCode: 2,
    });
  });

  it('returns exitCode 124 on timeout without throwing', async () => {
    const shell = new FakeShell(async () => ({
      stdout: '',
      stderr: '',
      exitCode: 124,
    }));
    const tool = createShellTool({ shell });
    const result = await tool.execute!({ command: 'sleep 99', timeout: 1 });
    expect(result).toMatchObject({
      op: 'bash',
      ok: false,
      exitCode: 124,
    });
    expect(result.stderr).toContain('timed out after 1s');
  });

  it('returns exitCode 124 when shell throws a timeout error', async () => {
    const shell = new FakeShell(async () => {
      throw new Error('command timed out');
    });
    const tool = createShellTool({ shell });
    const result = await tool.execute!({ command: 'sleep 99', timeout: 2 });
    expect(result).toMatchObject({
      op: 'bash',
      ok: false,
      exitCode: 124,
      stdout: '',
    });
    expect(result.stderr).toContain('timed out after 2s');
  });

  it('truncates combined stdout+stderr over MAX_SHELL_OUTPUT_BYTES', async () => {
    const big = 'x'.repeat(MAX_SHELL_OUTPUT_BYTES);
    const shell = new FakeShell(async () => ({
      stdout: big,
      stderr: 'tail',
      exitCode: 0,
    }));
    const tool = createShellTool({ shell });
    const result = await tool.execute!({ command: 'cat huge' });
    expect(result.stdout.length + result.stderr.length).toBeLessThanOrEqual(
      MAX_SHELL_OUTPUT_BYTES + 80,
    );
    expect(result.stderr).toContain('truncated');
  });

  it('rethrows when host abortSignal is already aborted', async () => {
    const shell = new FakeShell(async () => ({ stdout: '', stderr: '', exitCode: 0 }));
    const tool = createShellTool({ shell });
    const controller = new AbortController();
    controller.abort();
    await expect(
      tool.execute!({ command: 'echo hi' }, { abortSignal: controller.signal }),
    ).rejects.toMatchObject({ name: 'AbortError' });
  });
});

describe('resolveAgentWorkspace shell', () => {
  it('returns shell from the object form', () => {
    const fs = new InMemoryFs({});
    const shell = new FakeShell(async () => ({ stdout: '', stderr: '', exitCode: 0 }));
    const resolved = resolveAgentWorkspace({ fs, shell, readOnly: false });
    expect(resolved?.shell).toBe(shell);
    expect(resolved?.readOnly).toBe(false);
  });

  it('bare FileSystem resolves to readOnly:true and shell undefined', () => {
    const fs = new InMemoryFs({});
    const resolved = resolveAgentWorkspace(fs);
    expect(resolved?.readOnly).toBe(true);
    expect(resolved?.shell).toBeUndefined();
  });
});