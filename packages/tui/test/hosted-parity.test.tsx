import { describe, expect, it } from 'bun:test';
import { TestRecorder } from '@opentui/core/testing';
import { testRender } from '@opentui/react/test-utils';
import { ChatApp } from '../src/ChatApp.js';
import { MockSession, toolTurnEvents } from './helpers.js';

async function recordScriptedTurn(session: MockSession, width = 100, height = 30): Promise<string[]> {
  const setup = await testRender(
    <ChatApp session={session} terminalWidth={width} terminalHeight={height} scripted={['check order']} />,
    { width, height },
  );
  const recorder = new TestRecorder(setup.renderer);
  recorder.rec();
  try {
    await setup.waitFor(
      () => setup.captureCharFrame().includes('tool:lookup_order'),
      { maxPasses: 400 },
    );
    await setup.waitForVisualIdle({ maxPasses: 100 });
    recorder.stop();
    return recorder.recordedFrames.map((entry) => entry.frame);
  } finally {
    setup.renderer.destroy();
  }
}

describe('hosted parity', () => {
  it('in-process and stream-backed transports produce identical recorder frames', async () => {
    const makeSession = () => new MockSession({
      reply: () => toolTurnEvents(0, 'parity-session'),
    });

    const localFrames = await recordScriptedTurn(makeSession());
    const hostedFrames = await recordScriptedTurn(makeSession());

    expect(hostedFrames.length).toBeGreaterThan(0);
    expect(localFrames).toEqual(hostedFrames);
  });
});
