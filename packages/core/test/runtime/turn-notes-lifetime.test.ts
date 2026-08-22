import { describe, expect, it } from 'bun:test';
import { defineAgent } from '../../src/authoring/defineAgent.js';
import { createRuntime } from '../../src/runtime/Runtime.js';
import {
  addSystemNote,
  consumeTurnNotes,
  systemNoteBlocks,
} from '../../src/runtime/systemNotes.js';
import { MemoryStore } from '../../src/session/stores/MemoryStore.js';
import { SessionRunStore } from '../../src/runtime/durable/SessionRunStore.js';
import type { ChannelDriver, ResolvedNode } from '../../src/types/channel.js';
import type { RunContext } from '../../src/types/run-context.js';
import { stubModel } from '../core-durable/helpers.js';

const TURN_NOTE = 'TURN-LIFETIME-NOTE-XYZZY';
const RUN_NOTE = 'RUN-LIFETIME-NOTE-XYZZY';

function noteCapturingDriver() {
  const composedNotes: string[][] = [];
  const driver: ChannelDriver = {
    async runAgentTurn(_node: ResolvedNode, ctx: RunContext) {
      composedNotes.push([...systemNoteBlocks(ctx.runState)]);
      return { text: 'ok', toolResults: [] };
    },
    async awaitUser() {
      return { type: 'message', input: '' };
    },
  };
  return { driver, composedNotes };
}

describe('turn-lifetime system notes', () => {
  it('turn notes appear in the composed turn and are absent on the next turn; run notes survive', async () => {
    const sessionStore = new MemoryStore();
    const { driver, composedNotes } = noteCapturingDriver();
    const runtime = createRuntime({
      agents: [defineAgent({ id: 'a', instructions: 'agent', model: stubModel })],
      defaultAgentId: 'a',
      sessionStore,
    });

    const sessionId = 'turn-note-sess';
    const runStore = new SessionRunStore(sessionStore, sessionId);

    await runtime.run({
      sessionId,
      input: 'first',
      driver: {
        ...driver,
        async runAgentTurn(node, ctx) {
          addSystemNote(ctx.runState, TURN_NOTE, { lifetime: 'turn', tag: 'test-turn' });
          addSystemNote(ctx.runState, RUN_NOTE, { lifetime: 'run', tag: 'test-run' });
          return driver.runAgentTurn(node, ctx);
        },
      },
    });

    expect(composedNotes[0]?.join('\n')).toContain(TURN_NOTE);
    expect(composedNotes[0]?.join('\n')).toContain(RUN_NOTE);

    const afterFirst = await runStore.getRunState(sessionId);
    expect(systemNoteBlocks(afterFirst!).join('\n')).not.toContain(TURN_NOTE);
    expect(systemNoteBlocks(afterFirst!).join('\n')).toContain(RUN_NOTE);

    composedNotes.length = 0;
    await runtime.run({ sessionId, input: 'second', driver });

    expect(composedNotes[0]?.join('\n')).not.toContain(TURN_NOTE);
    expect(composedNotes[0]?.join('\n')).toContain(RUN_NOTE);
  });
});

describe('consumeTurnNotes guard', () => {
  it('drops turn-lifetime notes from run state', () => {
    const run = {
      state: {},
    };
    addSystemNote(run, TURN_NOTE, { lifetime: 'turn', tag: 't' });
    addSystemNote(run, RUN_NOTE, { lifetime: 'run', tag: 'r' });
    consumeTurnNotes(run);
    const blocks = systemNoteBlocks(run).join('\n');
    expect(blocks).not.toContain(TURN_NOTE);
    expect(blocks).toContain(RUN_NOTE);
  });
});
