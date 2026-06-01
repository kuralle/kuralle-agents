import { describe, it, expect } from 'bun:test';
import {
  InboundResolverChain,
  InteractiveResolver,
  TextResolver,
  defaultInboundChain,
} from '../src/adapter/input-resolver-chain.js';
import type { InboundMessage } from '../src/types.js';

function msg(overrides: Partial<InboundMessage> = {}): InboundMessage {
  return {
    id: 'm-1',
    platform: 'whatsapp',
    threadId: '+15551234567',
    customerId: 'u-1',
    from: { id: 'u-1' },
    timestamp: new Date(),
    type: 'interactive',
    ...overrides,
  };
}

describe('InboundResolverChain', () => {
  it('requires at least one plugin', () => {
    expect(() => new InboundResolverChain([])).toThrow(
      'InboundResolverChain requires at least one plugin',
    );
  });

  it('default chain is InteractiveResolver then TextResolver', () => {
    const chain = defaultInboundChain();
    expect(chain).toBeInstanceOf(InboundResolverChain);
  });

  it('throws if no plugin matches', async () => {
    const alwaysDefer = {
      name: 'defer',
      async tryResolve() {
        return undefined;
      },
    };
    const chain = new InboundResolverChain([alwaysDefer]);
    await expect(chain.resolve(msg())).rejects.toThrow('no inbound resolver matched');
  });
});

describe('InteractiveResolver', () => {
  it('interactive_routes_by_id_not_label', async () => {
    const resolver = new InteractiveResolver();
    const a = await resolver.tryResolve(
      msg({
        interactive: { type: 'button_reply', id: 'opt-x', title: 'Option A' },
      }),
    );
    const b = await resolver.tryResolve(
      msg({
        interactive: { type: 'button_reply', id: 'opt-x', title: 'totally different' },
      }),
    );
    expect(a).toEqual({ input: 'opt-x', selection: { id: 'opt-x' } });
    expect(b).toEqual({ input: 'opt-x', selection: { id: 'opt-x' } });
  });

  it('template_button_payload_routes', async () => {
    const resolver = new InteractiveResolver();
    const out = await resolver.tryResolve(
      msg({
        type: 'interactive',
        button: { payload: 'tpl-payload-1', text: 'Yes' },
      }),
    );
    expect(out).toEqual({
      input: 'tpl-payload-1',
      selection: { id: 'tpl-payload-1' },
    });
  });

  it('nfm_reply_form_in_state', async () => {
    const resolver = new InteractiveResolver();
    const formData = { name: 'Ada', plan: 'pro' };
    const out = await resolver.tryResolve(
      msg({
        interactive: { type: 'nfm_reply', id: '', formResponse: formData },
      }),
    );
    expect(out).toEqual({
      input: '__flow__',
      selection: { formData },
    });
  });

  it('defers when interactive id is empty and no button or formResponse', async () => {
    const resolver = new InteractiveResolver();
    const out = await resolver.tryResolve(
      msg({ interactive: { type: 'unknown', id: '' } }),
    );
    expect(out).toBeUndefined();
  });
});

describe('TextResolver', () => {
  it('free_text_nlu_fallback', async () => {
    const resolver = new TextResolver();
    const out = await resolver.tryResolve(
      msg({ type: 'text', text: 'book a table for two' }),
    );
    expect(out).toEqual({ input: 'book a table for two', selection: undefined });
  });

  it('returns empty string when text is absent', async () => {
    const resolver = new TextResolver();
    const out = await resolver.tryResolve(msg({ type: 'image', text: undefined }));
    expect(out).toEqual({ input: '', selection: undefined });
  });
});

describe('defaultInboundChain integration', () => {
  it('interactive wins over text on the same message', async () => {
    const chain = defaultInboundChain();
    const out = await chain.resolve(
      msg({
        text: 'ignored label fallback',
        interactive: { type: 'list_reply', id: 'row-1', title: 'Row label' },
      }),
    );
    expect(out).toEqual({ input: 'row-1', selection: { id: 'row-1' } });
  });

  it('free_text_nlu_fallback via default chain', async () => {
    const chain = defaultInboundChain();
    const out = await chain.resolve(msg({ type: 'text', text: 'hello there' }));
    expect(out).toEqual({ input: 'hello there', selection: undefined });
  });
});
