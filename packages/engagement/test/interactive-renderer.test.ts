import { describe, it, expect } from 'bun:test';
import type { ChoiceOption } from '@kuralle-agents/core';
import type { OutboundRequest, SendOutcome } from '@kuralle-agents/messaging';
import { renderChoices, interactiveRenderer } from '../src/interactive-renderer.js';

function opts(count: number, labelPrefix = 'Opt'): ChoiceOption[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `id-${i + 1}`,
    label: `${labelPrefix} ${i + 1}`,
  }));
}

describe('render_picks_buttons_then_list', () => {
  it('renders 3 options as buttons', () => {
    const msg = renderChoices(opts(3), 'Pick one');
    expect(msg.type).toBe('buttons');
    expect(msg.action.type).toBe('buttons');
    if (msg.action.type !== 'buttons') throw new Error('expected buttons action');
    expect(msg.action.buttons).toHaveLength(3);
    expect(msg.body).toBe('Pick one');
  });

  it('renders 6 options as a list with 6 rows', () => {
    const msg = renderChoices(opts(6), 'Choose');
    expect(msg.type).toBe('list');
    expect(msg.action.type).toBe('list');
    if (msg.action.type !== 'list') throw new Error('expected list action');
    const rows = msg.action.sections[0]!.rows;
    expect(rows).toHaveLength(6);
    expect(msg.action.button).toBe('Choose');
  });
});

describe('renderer_rejects_over_limit', () => {
  it('throws when more than 10 options', () => {
    expect(() => renderChoices(opts(11), 'Too many')).toThrow(
      /too many options \(max 10 list rows\)/,
    );
  });

  it('throws when a button title exceeds 20 characters', () => {
    const options: ChoiceOption[] = [
      { id: 'a', label: 'A'.repeat(21) },
      { id: 'b', label: 'OK' },
    ];
    expect(() => renderChoices(options, 'Pick')).toThrow(/button title.*exceeds 20/);
  });

  it('throws when a list row title exceeds 24 characters', () => {
    const options: ChoiceOption[] = Array.from({ length: 5 }, (_, i) => ({
      id: `id-${i}`,
      label: i === 0 ? 'L'.repeat(25) : `Row ${i}`,
    }));
    expect(() => renderChoices(options, 'List')).toThrow(/list row title.*exceeds 24/);
  });
});

describe('interactiveRenderer', () => {
  const baseReq: OutboundRequest = {
    threadId: 't-1',
    platform: 'whatsapp',
    payload: { kind: 'text', text: 'hello' },
    meta: {
      window: { open: true, expiresAt: new Date('2099-01-01') },
      parts: [],
      sessionId: 'sess-1',
    },
  };

  it('rewrites payload when an interactive part is present', async () => {
    const mw = interactiveRenderer();
    let seen: OutboundRequest | undefined;
    await mw.send(
      {
        ...baseReq,
        meta: {
          ...baseReq.meta,
          parts: [
            {
              type: 'interactive',
              nodeId: 'pick',
              options: opts(2),
              prompt: 'Select',
            },
          ],
        },
      },
      async (req) => {
        seen = req;
        return { kind: 'sent', result: { messageId: 'm1', threadId: 't-1', timestamp: new Date() } };
      },
    );

    expect(seen).toBeDefined();
    expect(seen!.payload.kind).toBe('interactive');
    if (seen!.payload.kind !== 'interactive') throw new Error('expected interactive payload');
    expect(seen!.payload.interactive.type).toBe('buttons');
    expect(seen!.payload.interactive.body).toBe('Select');
  });

  it('passes through when no interactive part', async () => {
    const mw = interactiveRenderer();
    let same = false;
    const req = baseReq;
    await mw.send(req, async (r) => {
      same = r === req;
      return { kind: 'sent', result: { messageId: 'm1', threadId: 't-1', timestamp: new Date() } };
    });
    expect(same).toBe(true);
  });

  it('is named interactive-renderer', () => {
    expect(interactiveRenderer().name).toBe('interactive-renderer');
  });

  it('propagates render errors (over limit)', async () => {
    const mw = interactiveRenderer();
    await expect(
      mw.send(
        {
          ...baseReq,
          meta: {
            ...baseReq.meta,
            parts: [
              {
                type: 'interactive',
                nodeId: 'pick',
                options: opts(11),
                prompt: 'Too many',
              },
            ],
          },
        },
        async () => ({ kind: 'sent' } as SendOutcome),
      ),
    ).rejects.toThrow(/too many options/);
  });
});

describe('renderChoices flow and url', () => {
  it('renders a flow option', () => {
    const msg = renderChoices(
      [{ id: 'flow-1', label: 'Start', flow: { flowId: 'F1', cta: 'Open' } }],
      'Flow prompt',
    );
    expect(msg.type).toBe('flow');
    if (msg.action.type !== 'flow') throw new Error('expected flow action');
    expect(msg.action.flowId).toBe('F1');
  });

  it('renders url options as buttons (cta-style mapping)', () => {
    const msg = renderChoices(
      [{ id: 'link-1', label: 'Visit', url: 'https://example.com' }],
      'Go',
    );
    expect(msg.type).toBe('buttons');
    if (msg.action.type !== 'buttons') throw new Error('expected buttons');
    expect(msg.action.buttons).toHaveLength(1);
  });
});
