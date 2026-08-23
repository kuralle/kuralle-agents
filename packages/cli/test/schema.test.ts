import { describe, expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TurnResultSchema, turnResultJsonSchema } from '../src/turnResult.js';
import { statusFixtures } from './fixtures/turn-result-fixtures.js';

const here = dirname(fileURLToPath(import.meta.url));
const cli = join(here, '../dist/cli.js');

describe('schema command', () => {
  it('kuralle schema prints JSON Schema that jq can parse', () => {
    const result = spawnSync('bash', ['-lc', `${process.execPath} ${cli} schema | jq .`], {
      encoding: 'utf8',
      input: '',
    });
    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    const schema = JSON.parse(result.stdout.trim()) as Record<string, unknown>;
    expect(schema.title).toBe('kuralle turn result');
  });

  it('each status fixture validates against the zod schema and generated JSON Schema', () => {
    for (const [status, fixture] of Object.entries(statusFixtures)) {
      expect(() => TurnResultSchema.parse(fixture)).not.toThrow();
      expect(fixture.status).toBe(status);
      expect(turnResultJsonSchema).toHaveProperty('$schema');
    }
  });
});
