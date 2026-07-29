import { describe, expect, it } from 'bun:test';
import { runProcess } from '../src/process.js';

describe('runProcess', () => {
  it('bounds captured stdout while preserving a truncation signal', async () => {
    const result = await runProcess(
      [process.execPath, '-e', 'process.stdout.write("x".repeat(250000))'],
      { cwd: process.cwd() },
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout.length).toBeLessThanOrEqual(200_000);
    expect(result.stdout).toEndWith('[output truncated at 200000 characters]');
  });
});
