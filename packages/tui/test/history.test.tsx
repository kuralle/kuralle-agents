import { describe, expect, it } from 'bun:test';
import { testRender } from '@opentui/react/test-utils';
import { ChatApp } from '../src/ChatApp.js';
import { MockSession, seedFiveTurnHistory } from './helpers.js';

describe('history on attach', () => {
  it('renders five seeded turns before any input', async () => {
    const session = new MockSession({
      id: 'history-session',
      seed: seedFiveTurnHistory(),
    });

    const setup = await testRender(
      <ChatApp session={session} terminalWidth={80} terminalHeight={40} />,
      { width: 80, height: 40 },
    );

    try {
      await setup.waitForVisualIdle({ maxPasses: 100 });
      const frame = setup.captureCharFrame();
      for (let turn = 1; turn <= 5; turn += 1) {
        expect(frame).toContain(`history turn ${turn}`);
        expect(frame).toContain(`reply ${turn}`);
      }
    } finally {
      setup.renderer.destroy();
    }
  });
});
