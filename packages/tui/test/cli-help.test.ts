import { describe, expect, it } from 'bun:test';
import { CLI_USAGE_FLAGS, formatCliUsage, wantsCliUsage } from '../src/cliUsage.js';

describe('cli usage', () => {
  it('detects --help and -h before launch resolution', () => {
    expect(wantsCliUsage(['--help'])).toBe(true);
    expect(wantsCliUsage(['-h'])).toBe(true);
    expect(wantsCliUsage(['https://agent.example', '--agent-name', 'support'])).toBe(false);
  });

  it('names every accepted flag and states the Bun requirement', () => {
    const usage = formatCliUsage();

    expect(usage).toContain('Requires Bun >= 1.3');
    expect(usage).toContain('server|path');
    for (const [flag] of CLI_USAGE_FLAGS) {
      expect(usage).toContain(flag);
    }
    expect(usage).toContain('--help');
  });
});
