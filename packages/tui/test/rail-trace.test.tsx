import { describe, expect, it } from 'bun:test';
import { testRender } from '@opentui/react/test-utils';
import { ChatApp } from '../src/ChatApp.js';
import { MockSession, toolTurnEvents } from './helpers.js';

describe('trace rail', () => {
  it('renders tool span duration and token line; ^t/^m switch tabs', async () => {
    const session = new MockSession({
      reply: (_input, turn) => toolTurnEvents(turn * 10, 'trace-session'),
    });

    const setup = await testRender(
      <ChatApp session={session} terminalWidth={100} terminalHeight={30} />,
      { width: 100, height: 30, kittyKeyboard: true },
    );

    try {
      await setup.waitForVisualIdle({ maxPasses: 100 });
      await setup.mockInput.typeText('check order');
      await setup.mockInput.pressEnter();
      await setup.waitFor(
        () => setup.captureCharFrame().includes('tool:lookup_order'),
        { maxPasses: 300 },
      );
      await setup.waitForVisualIdle({ maxPasses: 100 });

      let frame = setup.captureCharFrame();
      expect(frame).toContain('tool:lookup_order');
      expect(frame).toMatch(/200ms/);
      expect(frame).toContain('120↓/34↑ tok');
      expect(frame).toContain('ctx 4096 tok');
      expect(frame).toContain('TTFT 50ms');

      setup.mockInput.pressKey('m', { ctrl: true });
      await setup.waitForVisualIdle({ maxPasses: 100 });
      frame = setup.captureCharFrame();
      expect(frame).toContain('Memory');

      setup.mockInput.pressKey('t', { ctrl: true });
      await setup.waitForVisualIdle({ maxPasses: 100 });
      frame = setup.captureCharFrame();
      expect(frame).toContain('Trace');
      expect(frame).toContain('tool:lookup_order');
    } finally {
      setup.renderer.destroy();
    }
  });
});
