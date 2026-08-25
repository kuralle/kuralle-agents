import { describe, expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sendCommand } from '../src/send.js';

const here = dirname(fileURLToPath(import.meta.url));
const cli = join(here, '../src/cli.ts');

function sendHelp(): string {
  const result = spawnSync('bun', [cli, 'send', '--help'], { encoding: 'utf8' });
  expect(result.status).toBe(0);
  return result.stdout;
}

describe('test:cli-send-help', () => {
  it('lists every option registered on sendCommand', () => {
    const help = sendHelp();
    const registered = sendCommand()
      .createHelp()
      .visibleOptions(sendCommand())
      .map((option) => option.flags.split(',')[0]!.trim());
    for (const flag of registered) {
      expect(help).toContain(flag);
    }
  });
});
