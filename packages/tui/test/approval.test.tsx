import { describe, expect, it } from 'bun:test';
import { testRender } from '@opentui/react/test-utils';
import { ChatApp } from '../src/ChatApp.js';
import {
  approvalPauseEvents,
  approvalResumeEvents,
  MockSession,
  sampleApprovalInterrupt,
} from './helpers.js';

describe('approval panel', () => {
  it('renders the panel, disables the composer, and resumes on approve', async () => {
    const session = new MockSession({
      reply: () => approvalPauseEvents(10),
    });

    const setup = await testRender(
      <ChatApp session={session} terminalWidth={80} terminalHeight={30} />,
      { width: 80, height: 30 },
    );

    try {
      await setup.mockInput.typeText('issue refund');
      await setup.mockInput.pressEnter();
      await setup.waitFor(
        () => setup.captureCharFrame().includes('issue_refund'),
        { maxPasses: 300 },
      );

      const pausedFrame = setup.captureCharFrame();
      expect(pausedFrame).toContain('issue_refund');
      expect(pausedFrame).toContain('4471');
      expect(pausedFrame).toContain('Approval required');
      expect(pausedFrame).toMatch(/disabled|input disabled/i);

      setup.mockInput.pressEnter();
      await setup.waitFor(
        () => setup.captureCharFrame().includes('Refund issued'),
        { maxPasses: 300 },
      );
      expect(session.lastRespondPayload).toEqual([
        { requestId: sampleApprovalInterrupt.requestId, decision: 'approve' },
      ]);
    } finally {
      setup.renderer.destroy();
    }
  });

  it('resumes with a denial when Deny is selected', async () => {
    const session = new MockSession({
      reply: () => approvalPauseEvents(10),
    });

    const setup = await testRender(
      <ChatApp session={session} terminalWidth={80} terminalHeight={30} />,
      { width: 80, height: 30 },
    );

    try {
      await setup.mockInput.typeText('issue refund');
      await setup.mockInput.pressEnter();
      await setup.waitFor(
        () => setup.captureCharFrame().includes('issue_refund'),
        { maxPasses: 300 },
      );

      setup.mockInput.pressArrow('down');
      setup.mockInput.pressEnter();
      await setup.waitFor(
        () => setup.captureCharFrame().includes('Refund denied'),
        { maxPasses: 300 },
      );
      expect(session.lastRespondPayload).toEqual([
        { requestId: sampleApprovalInterrupt.requestId, decision: 'deny' },
      ]);
    } finally {
      setup.renderer.destroy();
    }
  });

  it('shows resume events from the mock respond path', async () => {
    const session = new MockSession({
      reply: () => approvalPauseEvents(0),
      onRespond: (responses) => {
        const decision = responses[0]?.decision ?? 'approve';
        return approvalResumeEvents(10, decision);
      },
    });

    const setup = await testRender(
      <ChatApp session={session} terminalWidth={80} terminalHeight={24} />,
      { width: 80, height: 24 },
    );

    try {
      await setup.mockInput.typeText('go');
      await setup.mockInput.pressEnter();
      await setup.waitFor(
        () => setup.captureCharFrame().includes('issue_refund'),
        { maxPasses: 300 },
      );
      setup.mockInput.pressEnter();
      await setup.waitFor(
        () => setup.captureCharFrame().includes('Refund issued'),
        { maxPasses: 300 },
      );
    } finally {
      setup.renderer.destroy();
    }
  });
});
