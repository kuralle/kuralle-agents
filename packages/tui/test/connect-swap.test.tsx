import { describe, expect, it } from 'bun:test';
import { testRender } from '@opentui/react/test-utils';
import type { Client, Target } from '@kuralle-agents/client';
import { KuralleTui } from '../src/KuralleTui.js';
import { assistantTurnEvents, MockSession } from './helpers.js';

/**
 * This drives the slash handler directly rather than typing `/connect` into the composer, and the
 * reason is a real limitation rather than a harness quirk: `ChatApp` renders the input only when
 * `!composerDisabled`, and `composerDisabled` is `busy || approvalPending !== null`. While a turn
 * is streaming there is no input element on screen to type into, so no slash command is reachable
 * at the moment `/connect` is most wanted. What this proves is that the handler is correct — the
 * previous stream is cancelled, the new snapshot renders, and a late push from the old session
 * does not leak into the frame. Reaching it mid-stream is tracked separately.
 */
describe('/connect mid-session swap', () => {
  it('the handler aborts the previous stream and renders the new snapshot, with no leaked follower', async () => {
    let cancelA = false;
    const sessionA = new MockSession({
      id: 'session-a',
      stallAfterDelta: true,
      onCancel: () => {
        cancelA = true;
      },
      reply: () => assistantTurnEvents(0, 'Partial from A'),
    });
    const sessionB = new MockSession({
      id: 'session-b',
      seed: [
        ...assistantTurnEvents(0, 'Snapshot from B', 'session-b'),
      ],
    });

    let active: 'a' | 'b' = 'a';
    let runSlash: (command: string) => Promise<boolean> = async () => false;
    const createClientFn = (_target: Target): Client => ({
      sessions: {
        create: () => (active === 'a' ? sessionA : sessionB),
        attach: (id) => new MockSession({ id }),
      },
    });

    const setup = await testRender(
      <KuralleTui
        terminalWidth={90}
        terminalHeight={24}
        createClientFn={createClientFn}
        initialTarget={{ kind: 'http', url: 'http://a.example' }}
        initialClient={createClientFn({ kind: 'http', url: 'http://a.example' })}
        initialSession={sessionA}
        initialTitle="http://a.example"
        exposeSlash={(fn) => {
          runSlash = fn;
        }}
      />,
      { width: 90, height: 24 },
    );

    try {
      await setup.waitForVisualIdle({ maxPasses: 100 });
      await setup.mockInput.typeText('start on A');
      await setup.mockInput.pressEnter();
      await setup.waitFor(() => setup.captureCharFrame().includes('Partial from A'), { maxPasses: 300 });

      active = 'b';
      await runSlash('/connect http://b.ex --agent-name sa');
      await setup.waitFor(() => setup.captureCharFrame().includes('Snapshot from B'), { maxPasses: 400 });
      expect(setup.captureCharFrame()).not.toContain('Partial from A');

      sessionA.pushEvents(assistantTurnEvents(100, 'Leaked from A'));
      await setup.waitForVisualIdle({ maxPasses: 50 });
      expect(setup.captureCharFrame()).not.toContain('Leaked from A');
      expect(cancelA).toBe(true);
    } finally {
      setup.renderer.destroy();
    }
  });
});
