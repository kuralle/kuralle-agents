import { describe, expect, it } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

describe('KuralleAgent sweep wiring', () => {
  it('onScheduledJob runs both store sweeps and startRunSweeper enqueues via DO alarms', async () => {
    const source = await readFile(join(import.meta.dirname, '..', 'src', 'KuralleAgent.ts'), 'utf8');
    expect(source).toContain('recoverOrphanedRuns');
    expect(source).toContain('sweepDeadlines');
    expect(source).toContain('isSweepJob');
    expect(source).toContain('startRunSweeper');
    const onScheduled = source.slice(source.indexOf('protected async onScheduledJob'));
    expect(onScheduled).toContain('recoverOrphanedRuns(built.runtime)');
    expect(onScheduled).toContain('sweepDeadlines(built.runtime)');
  });
});
