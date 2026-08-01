/**
 * `buildRuntime` factories can now be sync or async. The loader's type already allowed a
 * Promise return; `buildFromFactory` threw `async buildRuntime factories are not supported`
 * at runtime instead of awaiting it — the shipped `release-governance-agent` example exports
 * exactly that shape and its own `chat` script could not run.
 *
 * These assert every loader shape the factory can legally return (sync AgentRuntime, async
 * AgentRuntime, async bare Runtime), and that a rejecting factory surfaces its own error
 * message instead of failing deep inside Ink's React reconciler.
 */
import { describe, expect, it } from 'bun:test';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveBuildRuntime } from '../src/agentLoader.js';
import { runChat } from '../src/chat.js';

async function writeAgentModule(contents: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'kuralle-cli-async-agent-'));
  const path = join(dir, 'kuralle.ts');
  await writeFile(path, contents);
  return path;
}

describe('test:cli-async-agent-loader', () => {
  it('loads a sync factory returning AgentRuntime', async () => {
    const path = await writeAgentModule(`
      export function buildRuntime(sessionId, store, traceStore) {
        return {
          runtime: { run: () => {}, listTraces: async () => [] },
          store,
          sessionId: sessionId ?? 'sync',
          agentId: 'sync-agent',
          label: 'sync agent',
          readState: async () => ({ roles: [] }),
        };
      }
    `);
    const buildRuntime = await resolveBuildRuntime(path);
    const result = await buildRuntime('s1');
    expect(result.sessionId).toBe('s1');
    expect(result.agentId).toBe('sync-agent');
  });

  it('awaits an async factory returning AgentRuntime — the regression this task fixes', async () => {
    const path = await writeAgentModule(`
      export async function buildRuntime(sessionId, store, traceStore) {
        await new Promise((resolve) => setTimeout(resolve, 1));
        return {
          runtime: { run: () => {}, listTraces: async () => [] },
          store,
          sessionId: sessionId ?? 'async',
          agentId: 'async-agent',
          label: 'async agent',
          readState: async () => ({ roles: [] }),
        };
      }
    `);
    const buildRuntime = await resolveBuildRuntime(path);
    const result = await buildRuntime('s2');
    expect(result.sessionId).toBe('s2');
    expect(result.agentId).toBe('async-agent');
  });

  it('assembles an AgentRuntime when an async factory returns a bare Runtime', async () => {
    const path = await writeAgentModule(`
      export async function buildRuntime() {
        await Promise.resolve();
        return { run: () => {}, listTraces: async () => [] };
      }
    `);
    const buildRuntime = await resolveBuildRuntime(path);
    const result = await buildRuntime('s3');
    expect(result.sessionId).toBe('s3');
    expect(result.agentId).toBe('agent');
    expect(typeof result.readState).toBe('function');
  });

  it('a rejecting factory surfaces its own message, not a swallowed/replaced error', async () => {
    const path = await writeAgentModule(`
      export async function buildRuntime() {
        throw new Error('boom: could not load remote config');
      }
    `);
    const buildRuntime = await resolveBuildRuntime(path);
    await expect(buildRuntime('s4')).rejects.toThrow('boom: could not load remote config');
  });

  it('runChat rejects before render() when the factory throws — no react-reconciler frame', async () => {
    const path = await writeAgentModule(`
      export async function buildRuntime() {
        throw new Error('boom: could not load remote config');
      }
    `);
    const buildRuntime = await resolveBuildRuntime(path);

    let caught: unknown;
    try {
      await runChat([], buildRuntime);
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toBe('boom: could not load remote config');
    expect((caught as Error).stack ?? '').not.toContain('react-reconciler');
  });
});
