import { describe, expect, it } from 'bun:test';
import { testRender } from '@opentui/react/test-utils';
import { ChatApp } from '../src/ChatApp.js';
import { assistantTurnEvents, MockSession } from './helpers.js';

describe('chat core', () => {
  it('renders three scripted turns with markdown stripped of raw emphasis markers', async () => {
    let turn = 0;
    const session = new MockSession({
      reply: () => {
        turn += 1;
        return assistantTurnEvents(turn * 10, `Order **4471** shipped (turn ${turn}).`);
      },
    });

    const setup = await testRender(
      <ChatApp session={session} terminalWidth={100} terminalHeight={30} />,
      { width: 100, height: 30 },
    );

    try {
      await setup.waitForVisualIdle({ maxPasses: 100 });
      for (const message of ['one', 'two', 'three']) {
        await setup.mockInput.typeText(message);
        await setup.mockInput.pressEnter();
        await setup.waitFor(
          () => setup.captureCharFrame().includes(`turn ${turn}`),
          { maxPasses: 300 },
        );
        await setup.waitForVisualIdle({ maxPasses: 100 });
      }

      const frame = setup.captureCharFrame();
      expect(frame.match(/You/g)?.length).toBe(3);
      expect(frame.match(/Agent/g)?.length).toBe(3);
      expect(frame).toContain('4471');
      expect(frame).not.toContain('**');
    } finally {
      setup.renderer.destroy();
    }
  });
});
