import { describe, expect, it } from 'bun:test';
import { MockLanguageModelV3, simulateReadableStream } from 'ai/test';
import { z } from 'zod';
import { streamText, tool } from 'ai';
import { AiSdkModelTurnLoop } from '../../src/runtime/channels/AiSdkModelTurnLoop.ts';
import { createEventBus, createTurnHandle } from '../../src/events/TurnHandle.ts';
import type { ModelTurnLoopInput, ModelTurnLoopState } from '../../src/runtime/channels/ModelTurnLoop.ts';
import { CoreToolExecutor } from '../../src/tools/effect/index.ts';
import { createRunContext } from '../../src/runtime/ctx.ts';
import { setupDurableHarness } from '../core-durable/helpers.ts';

/**
 * ai 6.x shapes both of these as objects on the raw provider chunk — `finishReason.unified` and
 * `usage.inputTokens.total`. Passing the plain string/number forms the older mocks used makes
 * the SDK fall back to `finishReason: 'other'`, which silently turns every tool-calling mock
 * into one that appears to stop immediately, so a loop test built on it would pass without ever
 * reaching the branch it means to cover.
 */
const USAGE = { inputTokens: { total: 1 }, outputTokens: { total: 1 } };
const TOOL_CALLS = { unified: 'tool-calls' };
const STOP = { unified: 'stop' };

/**
 * A turn that spends its whole step budget calling tools must still answer.
 *
 * `maxSteps` defaults to 5. A specialist that grounds itself, loads two skills, writes a piece
 * and lints it exhausts that before it ever summarises, and the loop used to fall out of its
 * `for` with no further model call — ten tool calls, `finish`, and not one character of text.
 * The chat rendered the tool cards and no reply.
 */

/**
 * Offered to the model via `input.tools` AND registered on `node.localTools`: the loop offers
 * the former to the provider but resolves executions against the latter merged with
 * `ctx.globalTools`, so a tool present in only one of the two is never actually run.
 */
const NOOP_TOOL = tool({
  description: 'does nothing',
  inputSchema: z.object({}),
  execute: async () => 'ok',
});

/** A model that calls `noop` forever — it never volunteers to stop. */
function alwaysCallsTools(onCallWithoutTools: () => void) {
  let call = 0;
  return new MockLanguageModelV3({
    doStream: async ({ tools }) => {
      call += 1;
      // The wrap-up call is the one made with no tools at all. Distinguishing on that is the
      // whole contract: with tools present the model would just call another one.
      if (!tools || tools.length === 0) {
        onCallWithoutTools();
        return {
          stream: simulateReadableStream({
            chunks: [
              { type: 'stream-start', warnings: [] },
              { type: 'text-start', id: 'w' },
              { type: 'text-delta', id: 'w', delta: 'Here is what I did.' },
              { type: 'text-end', id: 'w' },
              { type: 'finish', finishReason: STOP, usage: USAGE },
            ] as never[],
          }),
        } as never;
      }
      return {
        stream: simulateReadableStream({
          chunks: [
            { type: 'stream-start', warnings: [] },
            { type: 'tool-call', toolCallId: `call-${call}`, toolName: 'noop', input: '{}' },
            { type: 'finish', finishReason: TOOL_CALLS, usage: USAGE },
          ] as never[],
        }),
      } as never;
    },
  });
}

/**
 * Unique per call. `applyPromptCache` is keyed by session id and `setupDurableHarness` defaults
 * every harness to `sess-1`, so sharing it lets one test read another's cached prompt — the
 * loop then runs against the wrong tool set and exits without dispatching anything. Passes
 * alone, fails in the suite.
 */
let harnessSeq = 0;

async function runLoop(purpose: 'speaking' | 'extraction', maxSteps: number) {
  let toolLessCalls = 0;
  const model = alwaysCallsTools(() => {
    toolLessCalls += 1;
  });
  harnessSeq += 1;
  const { session, runStore, runState } = await setupDurableHarness(
    `wrapup-sess-${harnessSeq}`,
    `wrapup-run-${harnessSeq}`,
  );
  const ctx = await createRunContext({
    session,
    runStore,
    runState,
    steps: [],
    toolExecutor: new CoreToolExecutor({ tools: {} }),
    model: model as never,
    emit: () => {},
  });

  const emitted: string[] = [];
  const state: ModelTurnLoopState = { toolResults: [], toolCallsMade: [], toolMessages: [] };
  const input = {
    purpose,
    node: { id: 'answer', localTools: { noop: NOOP_TOOL } },
    ctx,
    model: model as never,
    messages: [{ role: 'user', content: 'do the thing' }],
    system: [],
    volatileSystemBlocks: [],
    tools: { noop: NOOP_TOOL },
    maxSteps,
  } as unknown as ModelTurnLoopInput;

  await new AiSdkModelTurnLoop().run(input, state, (delta) => emitted.push(delta));
  return { text: emitted.join(''), toolLessCalls, toolCalls: state.toolCallsMade.length };
}

/**
 * These three need the REAL `streamText`, and inside the shared `bun test` process they cannot
 * have it.
 *
 * Eighty files in this suite call `mock.module('ai', …)`. Bun applies module mocks
 * process-wide and never lifts them, and several of those files sort ahead of this one, so by
 * the time these run `streamText` is whichever stub was installed last. It cannot be fixed from
 * the test side either: `AiSdkModelTurnLoop` imports `'ai'` itself, so restoring the module here
 * would not change what the code under test already resolved.
 *
 * So the file detects the stub and skips rather than failing — a red suite that is red for an
 * unrelated file's mock teaches nobody anything. To actually run them:
 *
 *     bun run test:turn-loop
 *
 * which executes this file in its own process where no other file has mocked `ai`. That script
 * is the real guard; the skip only keeps the shared suite honest about what it did not cover.
 */
const streamTextIsMocked = !/native code|streamText/.test(String(streamText).slice(0, 200));

const maybe = streamTextIsMocked ? it.skip : it;

describe('AiSdkModelTurnLoop — exhausting the step budget', () => {

  maybe('still answers when the budget runs out mid tool chain', async () => {
    const { text, toolLessCalls, toolCalls } = await runLoop('speaking', 3);

    expect(toolCalls).toBe(3); // the whole budget went to tools
    expect(toolLessCalls).toBe(1); // exactly one wrap-up, and it had no tools to call
    expect(text).toBe('Here is what I did.');
  });

  maybe('does not force prose on the silent extraction path', async () => {
    // Typed extraction is deliberately mute. A wrap-up here would put stray text on a path
    // whose entire purpose is to produce none.
    const { text, toolLessCalls } = await runLoop('extraction', 3);

    expect(toolLessCalls).toBe(0);
    expect(text).toBe('');
  });

  maybe('does not add a wrap-up when the model stopped on its own', async () => {
    // A budget of 1 with a model that speaks immediately: `finishReason` is not `tool-calls`,
    // so the loop exits deliberately and no extra call is made.
    let toolLessCalls = 0;
    const model = new MockLanguageModelV3({
      doStream: async ({ tools }) => {
        if (!tools || tools.length === 0) toolLessCalls += 1;
        return {
          stream: simulateReadableStream({
            chunks: [
              { type: 'stream-start', warnings: [] },
              { type: 'text-start', id: '1' },
              { type: 'text-delta', id: '1', delta: 'done' },
              { type: 'text-end', id: '1' },
              { type: 'finish', finishReason: STOP, usage: USAGE },
            ] as never[],
          }),
        } as never;
      },
    });
    const { session, runStore, runState } = await setupDurableHarness();
    const ctx = await createRunContext({
      session,
      runStore,
      runState,
      steps: [],
      toolExecutor: new CoreToolExecutor({ tools: {} }),
      model: model as never,
      emit: () => {},
    });
    const emitted: string[] = [];
    const state: ModelTurnLoopState = { toolResults: [], toolCallsMade: [], toolMessages: [] };
    await new AiSdkModelTurnLoop().run(
      {
        purpose: 'speaking',
        node: { id: 'answer', localTools: { noop: NOOP_TOOL } },
        ctx,
        model: model as never,
        messages: [{ role: 'user', content: 'hi' }],
        system: [],
        volatileSystemBlocks: [],
        tools: { noop: NOOP_TOOL },
        maxSteps: 1,
      } as unknown as ModelTurnLoopInput,
      state,
      (delta) => emitted.push(delta),
    );

    expect(toolLessCalls).toBe(0);
    expect(emitted.join('')).toBe('done');
  });
});

/**
 * A streamed turn must tell intermediaries not to buffer it.
 *
 * These live here rather than needing the real `streamText`, because the headers are set on the
 * Response and do not depend on a model running at all.
 */
describe('toUIMessageStreamResponse — anti-buffering headers', () => {
  it('refuses compression and re-encoding so a proxy cannot buffer the stream', async () => {
    const bus = createEventBus();
    const handle = createTurnHandle({
      run: () => Promise.resolve({ output: 'ok' } as never),
      bus,
    });
    const response = handle.toUIMessageStreamResponse({ sessionId: 's' });

    // `no-transform` is the standard signal; `identity` refuses compression outright. A Next.js
    // rewrite buffered the whole turn when the browser negotiated encoding, so the UI showed a
    // spinner and then everything at once.
    expect(response.headers.get('Cache-Control')).toContain('no-transform');
    expect(response.headers.get('Content-Encoding')).toBe('identity');
    // nginx's equivalent, for anyone terminating there.
    expect(response.headers.get('X-Accel-Buffering')).toBe('no');

    await handle;
  });
});
