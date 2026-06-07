import { describe, expect, it, mock, afterEach } from 'bun:test';
import { reply } from '../../src/types/flow.js';
import { TextDriver } from '../../src/runtime/channels/TextDriver.js';
import { createRunContext } from '../../src/runtime/ctx.js';
import { resolveReplyNode } from '../../src/flow/nodeBuilders.js';
import { CoreToolExecutor } from '../../src/tools/effect/index.js';
import { setupDurableHarness, stubModel } from '../core-durable/helpers.js';
import { defineAgent } from '../../src/authoring/defineAgent.js';
import { InMemoryPersistentMemoryStore } from '../../src/memory/blocks/InMemoryPersistentMemoryStore.js';
import {
  wireWorkingMemory,
  loadWorkingMemoryBlocks,
  formatWorkingMemorySection,
  resolveWorkingMemoryOwner,
} from '../../src/runtime/grounding/workingMemory.js';
import { FilePersistentMemoryStore } from '../../src/memory/blocks/FilePersistentMemoryStore.js';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

afterEach(() => {
  mock.restore();
});

describe('working memory wiring', () => {
  it('seeds empty blocks from template without persisting on read', async () => {
    const store = new InMemoryPersistentMemoryStore();
    const agent = defineAgent({
      id: 'agent-a',
      memory: {
        workingMemory: {
          store,
          autoLoad: [{ scope: 'user', key: 'USER', template: 'name: (unknown)' }],
        },
      },
    });

    const wired = await wireWorkingMemory(agent, {
      id: 's1',
      conversationId: 's1',
      channelId: 'api',
      userId: 'user-1',
      createdAt: new Date(),
      updatedAt: new Date(),
      messages: [],
      workingMemory: {},
      currentAgent: 'agent-a',
      activeAgentId: 'agent-a',
      agentStates: {},
      handoffHistory: [],
    });

    expect(wired?.promptSection).toContain('name: (unknown)');
    expect(await store.loadBlock('user', 'user-1', 'USER')).toBeNull();
  });

  it('persists USER block via tool and injects into a new session for the same userId', async () => {
    const store = new InMemoryPersistentMemoryStore();
    const agent = defineAgent({
      id: 'prefs',
      memory: {
        workingMemory: {
          store,
          autoLoad: [{ scope: 'user', key: 'USER' }],
        },
      },
    });

    const session1 = {
      id: 'sess-1',
      conversationId: 'sess-1',
      channelId: 'api',
      userId: 'user-42',
      createdAt: new Date(),
      updatedAt: new Date(),
      messages: [],
      workingMemory: {},
      currentAgent: 'prefs',
      activeAgentId: 'prefs',
      agentStates: {},
      handoffHistory: [],
    };

    const wired1 = await wireWorkingMemory(agent, session1);
    expect(wired1).toBeDefined();

    const tool = wired1!.memoryBlockTool;
    await tool.execute!({ action: 'add', block: 'USER', content: 'favorite color: teal' });

    const session2 = { ...session1, id: 'sess-2', conversationId: 'sess-2' };
    const wired2 = await wireWorkingMemory(agent, session2);
    expect(wired2?.promptSection).toContain('favorite color: teal');
    expect(wired2?.promptSection).toContain('### USER (user)');
  });

  it('injects working memory into the reply system prompt', async () => {
    let capturedSystem = '';
    mock.module('ai', () => {
      const actual = require('ai');
      return {
        ...actual,
        streamText: (opts: { system?: string }) => {
          capturedSystem = opts.system ?? '';
          return {
            fullStream: (async function* () {
              yield Object.assign({ type: 'text-delta' }, { text: 'Noted.' });
            })(),
            finishReason: Promise.resolve('stop'),
            response: Promise.resolve({ messages: [] }),
            toolCalls: Promise.resolve([]),
          };
        },
      };
    });

    const store = new InMemoryPersistentMemoryStore();
    await store.saveBlock(
      { key: 'USER', scope: 'user', content: 'prefers email contact', charLimit: 10_000 },
      'user-9',
    );

    const agent = defineAgent({
      id: 'support',
      memory: {
        workingMemory: { store, autoLoad: [{ scope: 'user', key: 'USER' }] },
      },
    });

    const { session, runStore, runState } = await setupDurableHarness('wm-sess', 'wm-run');
    session.userId = 'user-9';

    const wired = await wireWorkingMemory(agent, session);
    const toolExecutor = new CoreToolExecutor({
      tools: { memory_block: wired!.memoryBlockTool },
    });

    const ctx = await createRunContext({
      session,
      runState,
      runStore,
      steps: [],
      toolExecutor,
      model: stubModel,
      emit: () => {},
    });
    ctx.workingMemoryPrompt = wired?.promptSection;

    const node = reply({ id: 'answer', instructions: 'Answer using working memory.' });
    await new TextDriver().runAgentTurn(resolveReplyNode(node, runState.state), ctx);
    expect(capturedSystem).toContain('prefers email contact');
    expect(capturedSystem).toContain('## Working memory');
  });

  it('resolves owners: agent scope uses agent id, user scope uses userId', () => {
    expect(resolveWorkingMemoryOwner('agent', 'my-agent', 'user-1')).toBe('my-agent');
    expect(resolveWorkingMemoryOwner('user', 'my-agent', 'user-1')).toBe('user-1');
    expect(resolveWorkingMemoryOwner('shared', 'my-agent', undefined)).toBe('anonymous');
  });

  it('FilePersistentMemoryStore round-trips cross-session USER blocks on Node', async () => {
    const rootDir = path.join(
      os.tmpdir(),
      `kuralle-wm-file-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    await fs.mkdir(rootDir, { recursive: true });
    const store = new FilePersistentMemoryStore({ rootDir });

    const loaded = await loadWorkingMemoryBlocks(
      store,
      [{ scope: 'user', key: 'USER' }],
      (scope) => resolveWorkingMemoryOwner(scope, 'agent-x', 'file-user'),
    );
    expect(loaded).toEqual([]);

    await store.saveBlock(
      { key: 'USER', scope: 'user', content: 'timezone: US/Pacific', charLimit: 10_000 },
      'file-user',
    );

    const reloaded = await loadWorkingMemoryBlocks(
      store,
      [{ scope: 'user', key: 'USER' }],
      (scope) => resolveWorkingMemoryOwner(scope, 'agent-x', 'file-user'),
    );
    expect(formatWorkingMemorySection(reloaded)).toContain('timezone: US/Pacific');

    await fs.rm(rootDir, { recursive: true, force: true });
  });
});
