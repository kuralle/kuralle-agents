import { describe, expect, it } from 'bun:test';
import { fileURLToPath } from 'node:url';
import { parseCliArgv, resolveLaunchTarget } from '../src/cliArgs.js';

const fixtureAgent = fileURLToPath(new URL('./fixtures/local-agent.ts', import.meta.url));

/**
 * `kuralle-tui ./agent.ts` is documented in the chat guide and is what the scheme inference exists
 * for, but the launch path called resolveHostedConnection first. That normalises through
 * `new URL(...)`, which throws on a filesystem path, so the run died with "cannot be parsed as a
 * URL" and never reached the local branch sitting four lines below. The slash command `/agent`
 * worked the whole time, which is why no test caught it — the launch argument had none.
 */
describe('launch target resolution', () => {
  it('resolves a filesystem path to a local target', async () => {
    const options = parseCliArgv([fixtureAgent, '--model', 'gpt-4.1-mini']);
    const resolved = await resolveLaunchTarget(options);

    expect(resolved?.target.kind).toBe('local');
    expect(resolved?.label).toContain('local-agent');
  });

  it('still resolves a URL to a hosted target', async () => {
    const resolved = await resolveLaunchTarget(
      parseCliArgv(['https://agent.example', '--agent-name', 'support']),
    );

    expect(resolved?.target.kind).toBe('http');
  });
});
