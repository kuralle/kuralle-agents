import { describe, expect, it } from 'bun:test';
import { testRender } from '@opentui/react/test-utils';
import { ChatApp } from '../src/ChatApp.js';
import { lateExtractionTurnEvents, logged, MockSession } from './helpers.js';

describe('memory rail', () => {
  it('marks a slug changed when extraction arrives after done', async () => {
    const session = new MockSession({
      reply: () => lateExtractionTurnEvents(0, 'memory-session'),
      afterTurn: () => [
        logged(0, {
          channel: 'internal',
          type: 'extraction',
          payload: { slug: 'preference.seat', value: 'window', changed: true },
        }, { at: 800, eventId: 'evt-late-extraction' }),
      ],
    });

    const setup = await testRender(
      <ChatApp
        session={session}
        terminalWidth={100}
        terminalHeight={30}
        userId="alice"
        memoryConfigured
        fetchMemory={async () => ({
          blocks: [],
          extracted: [{ slug: 'preference.seat', scope: 'user', value: 'aisle', updatedAt: '2026-01-01T00:00:00Z' }],
        })}
      />,
      { width: 100, height: 30, kittyKeyboard: true },
    );

    try {
      await setup.waitForVisualIdle({ maxPasses: 100 });
      setup.mockInput.pressKey('m', { ctrl: true });
      await setup.mockInput.typeText('hello');
      await setup.mockInput.pressEnter();
      await setup.waitFor(
        () => setup.captureCharFrame().includes('preference.seat · changed'),
        { maxPasses: 400 },
      );
      await setup.waitForVisualIdle({ maxPasses: 100 });
      expect(setup.captureCharFrame()).toContain('preference.seat · changed');
    } finally {
      setup.renderer.destroy();
    }
  });

  it('shows the memory-off notice when no user is set', async () => {
    const setup = await testRender(
      <ChatApp
        session={new MockSession()}
        terminalWidth={100}
        terminalHeight={30}
        memoryConfigured
      />,
      { width: 100, height: 30, kittyKeyboard: true },
    );

    try {
      await setup.waitForVisualIdle({ maxPasses: 100 });
      setup.mockInput.pressKey('m', { ctrl: true });
      await setup.waitForVisualIdle({ maxPasses: 100 });
      const frame = setup.captureCharFrame();
      expect(frame).toContain('memory is off');
      expect(frame).not.toContain('(no blocks)');
    } finally {
      setup.renderer.destroy();
    }
  });
});
