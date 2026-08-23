import { describe, expect, it } from 'bun:test';
import { testRender } from '@opentui/react/test-utils';
import { ChatApp } from '../src/ChatApp.js';
import { assistantTurnEvents, MockSession } from './helpers.js';

describe('cancel mid-turn', () => {
  it('esc stops generation and the session accepts a following turn', async () => {
    let cancelled = false;
    let cancelTurn = () => {};
    const session = new MockSession({
      onCancel: () => {
        cancelled = true;
      },
      stallAfterDelta: true,
      reply: (input) => assistantTurnEvents(0, input === 'follow-up' ? 'Recovered.' : 'Partial…'),
    });

    const setup = await testRender(
      <ChatApp
        session={session}
        terminalWidth={80}
        terminalHeight={20}
        bindCancelHandler={(handler) => {
          cancelTurn = handler;
        }}
      />,
      { width: 80, height: 20 },
    );

    try {
      await setup.renderOnce();
      await setup.mockInput.typeText('first');
      await setup.mockInput.pressEnter();
      await setup.waitFor(() => setup.captureCharFrame().includes('Partial'), { maxPasses: 200 });
      cancelTurn();
      await setup.waitFor(() => cancelled, { maxPasses: 200 });
      await setup.waitForVisualIdle({ maxPasses: 100 });

      await setup.mockInput.typeText('follow-up');
      await setup.mockInput.pressEnter();
      await setup.waitFor(() => setup.captureCharFrame().includes('Recovered'), { maxPasses: 300 });
      expect(cancelled).toBe(true);
    } finally {
      setup.renderer.destroy();
    }
  });
});
