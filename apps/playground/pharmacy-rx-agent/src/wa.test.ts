import { describe, expect, test } from 'bun:test';
import { createHmac } from 'node:crypto';
import { Database } from 'bun:sqlite';
import type { HarnessStreamPart, Session, UserInputContent } from '@kuralle-agents/core';
import { verifySignature, normalizeWebhook } from '@kuralle-agents/messaging-meta/webhooks';
import {
  claimAndAppend,
  consentStop,
  conversationKeyToString,
  createInboundPipeline,
  defaultInboundChain,
  noopCoalesceScheduler,
  recordWindow,
  resolveAndAttachMedia,
  runTurn,
  statusReactionErrorPhase,
  systemClock,
  type ConversationKey,
  type InboundContext,
  type InboundEvent,
  type InboundMessage,
  type InboundRuntime,
  type MediaResolver,
  type OutboundSender,
  type TurnResult,
  type TurnRunner,
} from '@kuralle-agents/messaging';
import {
  QueuedTurnRunner,
  SqlConsentStore,
  SqlInboundLedger,
  SqlOwnershipStore,
  SqlWindowStore,
} from '../../../../packages/cf-agent/src/inbound-runtime.js';
import type { SqlExecutor } from '../../../../packages/cf-agent/src/types.js';
import { SqlSessionStore } from './wa-session-store.js';
import { encodeCheckoutToken, decodeCheckoutToken } from './token.js';

const APP_SECRET = 'test_app_secret';

function sign(body: string): string {
  return 'sha256=' + createHmac('sha256', APP_SECRET).update(body).digest('hex');
}

const imageWebhook = {
  object: 'whatsapp_business_account',
  entry: [
    {
      id: 'WABA_ID',
      changes: [
        {
          field: 'messages',
          value: {
            messaging_product: 'whatsapp',
            metadata: { display_phone_number: '15550009999', phone_number_id: 'PNID123' },
            contacts: [{ profile: { name: 'Jane' }, wa_id: '15551234567' }],
            messages: [
              {
                from: '15551234567',
                id: 'wamid.ABC',
                timestamp: '1700000000',
                type: 'image',
                image: { id: 'MEDIA123', mime_type: 'image/jpeg', caption: 'here is my rx' },
              },
            ],
          },
        },
      ],
    },
  ],
};

describe('WhatsApp webhook ingress', () => {
  test('verifySignature accepts a correctly-signed body and rejects tampering', () => {
    const body = JSON.stringify(imageWebhook);
    expect(verifySignature({ appSecret: APP_SECRET, rawBody: body, signatureHeader: sign(body) })).toBe(true);
    expect(verifySignature({ appSecret: 'wrong', rawBody: body, signatureHeader: sign(body) })).toBe(false);
    expect(verifySignature({ appSecret: APP_SECRET, rawBody: body, signatureHeader: '' })).toBe(false);
  });

  test('normalizeWebhook extracts the inbound image message + sender', () => {
    const events = normalizeWebhook(imageWebhook);
    expect(events.messages).toHaveLength(1);
    const m = events.messages[0];
    expect(m.from).toBe('15551234567');
    expect(m.type).toBe('image');
    expect(m.image?.id).toBe('MEDIA123');
  });
});

describe('SqlSessionStore (DO-SQLite durability)', () => {
  function makeStore() {
    const db = new Database(':memory:');
    const sql = {
      exec: (q: string, ...b: unknown[]) => {
        const rows = db.query(q).all(...(b as never[])) as Array<Record<string, unknown>>;
        return { toArray: () => rows };
      },
    };
    return new SqlSessionStore(sql);
  }

  test('round-trips a session, reviving Dates and preserving the durable run journal', async () => {
    const store = makeStore();
    const session = {
      id: 'wa:15551234567',
      conversationId: 'wa:15551234567',
      createdAt: new Date('2026-06-12T00:00:00.000Z'),
      updatedAt: new Date('2026-06-12T01:00:00.000Z'),
      messages: [{ role: 'user', content: 'hi' }],
      state: { cart: [{ id: 'amoxicillin-500', quantity: 2 }] },
      durableRuns: { 'run-1': { runState: { runId: 'run-1', updatedAt: 123 }, steps: [] } },
    } as unknown as Session;

    await store.save(session);
    const loaded = await store.get('wa:15551234567');
    expect(loaded).not.toBeNull();
    expect(loaded!.createdAt).toBeInstanceOf(Date);
    expect(loaded!.updatedAt.toISOString()).toBe('2026-06-12T01:00:00.000Z');
    expect((loaded!.state as { cart: unknown[] }).cart).toHaveLength(1);
    // The effect-log journal must survive serialization — this is what makes the
    // /wa-pay resume idempotent across DO eviction.
    expect((loaded as Record<string, unknown>).durableRuns).toBeDefined();
    expect(Object.keys((loaded as { durableRuns: object }).durableRuns)).toEqual(['run-1']);
  });

  test('get() returns null for an unknown session', async () => {
    expect(await makeStore().get('nope')).toBeNull();
  });
});

type SqlLike = {
  exec: (query: string, ...bindings: unknown[]) => { toArray: () => Array<Record<string, unknown>> };
};

function makeSql() {
  const db = new Database(':memory:');
  const raw: SqlLike = {
    exec: (q: string, ...b: unknown[]) => {
      const rows = db.query(q).all(...(b as never[])) as Array<Record<string, unknown>>;
      return { toArray: () => rows };
    },
  };
  const sql = ((strings: TemplateStringsArray, ...values: unknown[]) => {
    const query = strings.reduce(
      (acc, part, index) => acc + part + (index < values.length ? '?' : ''),
      '',
    );
    return raw.exec(query, ...values).toArray();
  }) as SqlExecutor;
  return { sql, raw };
}

function key(phoneNumberId = 'PNID123', from = '15551234567'): ConversationKey {
  return { platform: 'whatsapp', businessId: phoneNumberId, threadId: from };
}

function inboundMessage(id: string, text: string, k = key(), ts = Date.now()): InboundMessage {
  const threadId = conversationKeyToString(k);
  return {
    id,
    platform: 'whatsapp',
    threadId,
    customerId: threadId,
    from: { id: k.threadId, phone: k.threadId },
    timestamp: new Date(ts),
    type: 'text',
    text,
  };
}

function messageEvent(message: InboundMessage): InboundEvent {
  return { kind: 'message', id: message.id, ts: message.timestamp.getTime(), data: message };
}

function signalEvent(signalId: string): InboundEvent {
  return {
    kind: 'signal',
    id: `signal:${signalId}`,
    ts: Date.now(),
    data: { name: 'payment', signalId, payload: { paid: true } },
  };
}

function inputText(input: UserInputContent): string {
  if (typeof input === 'string') return input;
  return input
    .map((part) => {
      if (part.type === 'text') return part.text;
      if (part.type === 'file') return `[file:${part.mediaType}]`;
      return `[${part.type}]`;
    })
    .join('\n');
}

function textParts(text: string): HarnessStreamPart[] {
  return [
    { type: 'text-start', id: 't' },
    { type: 'text-delta', id: 't', delta: text },
    { type: 'text-end', id: 't' },
    { type: 'turn-end' },
  ];
}

class FakeTurnRunner implements TurnRunner {
  readonly turns: string[] = [];
  readonly signals: string[] = [];

  constructor(private readonly delayMs = 0) {}

  async runTurn(args: Parameters<TurnRunner['runTurn']>[0]): Promise<TurnResult> {
    if (this.delayMs > 0) await new Promise((resolve) => setTimeout(resolve, this.delayMs));
    const text = inputText(args.input);
    this.turns.push(text);
    return { parts: textParts(`reply:${text}`) };
  }

  async deliverSignal(args: Parameters<TurnRunner['deliverSignal']>[0]): Promise<TurnResult> {
    this.signals.push(args.signal.signalId);
    return { parts: textParts(`confirmed:${args.signal.signalId}`) };
  }
}

class FakeSender implements OutboundSender {
  readonly texts: string[] = [];

  async send(_ctx: InboundContext, result: TurnResult): Promise<void> {
    const text = result.parts
      .filter((part): part is Extract<HarnessStreamPart, { type: 'text-delta' }> => part.type === 'text-delta')
      .map((part) => part.delta)
      .join('');
    if (text) this.texts.push(text);
  }
}

const passthroughMedia: MediaResolver = {
  async resolve(_message, input) {
    return input;
  },
};

function makeRuntime(opts?: {
  runner?: TurnRunner;
  ledger?: SqlInboundLedger;
  media?: MediaResolver;
  sender?: FakeSender;
}): { rt: InboundRuntime; runner: TurnRunner; sender: FakeSender; sql: SqlExecutor } {
  const { sql } = makeSql();
  const ledger = opts?.ledger ?? new SqlInboundLedger(sql);
  const sender = opts?.sender ?? new FakeSender();
  const runner = opts?.runner ?? new FakeTurnRunner();
  return {
    sql,
    runner,
    sender,
    rt: {
      ledger,
      window: new SqlWindowStore(sql),
      consent: new SqlConsentStore(sql),
      ownership: new SqlOwnershipStore(sql),
      media: opts?.media ?? passthroughMedia,
      sender,
      runtime: runner,
      scheduler: noopCoalesceScheduler,
      clock: systemClock,
    },
  };
}

function makePipeline() {
  return createInboundPipeline([
    claimAndAppend(),
    statusReactionErrorPhase(),
    recordWindow(),
    consentStop(),
    resolveAndAttachMedia(defaultInboundChain()),
    runTurn(),
  ]);
}

describe('DO inbound pipeline adversarial cases', () => {
  test('duplicate Meta retry claims once and sends one reply', async () => {
    const fake = new FakeTurnRunner();
    const { rt, sender } = makeRuntime({ runner: fake });
    const pipeline = makePipeline();
    const k = key();
    const event = messageEvent(inboundMessage('wamid.1', 'hello', k));

    await pipeline.ingest(k, event, rt);
    await pipeline.ingest(k, event, rt);

    expect(fake.turns).toEqual(['hello']);
    expect(sender.texts).toEqual(['reply:hello']);
  });

  test('two /wa-pay clicks deliver one confirmation', async () => {
    const fake = new FakeTurnRunner();
    const { rt, sender } = makeRuntime({ runner: fake });
    const pipeline = makePipeline();
    const k = key();
    const event = signalEvent('sig-1');

    await pipeline.ingest(k, event, rt);
    await pipeline.ingest(k, event, rt);

    expect(fake.signals).toEqual(['sig-1']);
    expect(sender.texts).toEqual(['confirmed:sig-1']);
  });

  test('checkout can suspend, resume out-of-band, and ignore a re-click', async () => {
    class CheckoutRunner extends FakeTurnRunner {
      async runTurn(args: Parameters<TurnRunner['runTurn']>[0]): Promise<TurnResult> {
        const text = inputText(args.input);
        this.turns.push(text);
        return { parts: [{ type: 'paused', waitingFor: 'sig-checkout' }], suspended: { signalId: 'sig-checkout' } };
      }
    }

    const fake = new CheckoutRunner();
    const { rt, sender } = makeRuntime({ runner: fake });
    const pipeline = makePipeline();
    const k = key();

    const suspended = await pipeline.ingest(
      k,
      messageEvent(inboundMessage('wamid.checkout', 'checkout now', k)),
      rt,
    );
    await pipeline.ingest(k, signalEvent('sig-checkout'), rt);
    await pipeline.ingest(k, signalEvent('sig-checkout'), rt);

    expect(suspended).toEqual({ kind: 'suspended', signalId: 'sig-checkout' });
    expect(fake.turns).toEqual(['checkout now']);
    expect(fake.signals).toEqual(['sig-checkout']);
    expect(sender.texts).toEqual(['confirmed:sig-checkout']);
  });

  test('5-message burst debounces into one merged turn', async () => {
    const inner = new FakeTurnRunner();
    const queued = new QueuedTurnRunner(inner, undefined, { strategy: 'debounce', debounceMs: 5 });
    const { rt, sender } = makeRuntime({ runner: queued });
    const pipeline = makePipeline();
    const k = key();

    await Promise.all(
      ['one', 'two', 'three', 'four', 'five'].map((text, index) =>
        pipeline.ingest(k, messageEvent(inboundMessage(`wamid.${index}`, text, k, Date.now() + index)), rt),
      ),
    );

    expect(inner.turns).toHaveLength(1);
    expect(inner.turns[0]).toContain('one');
    expect(inner.turns[0]).toContain('five');
    expect(sender.texts).toHaveLength(1);
  });

  test('same-webhook same-thread messages run in order', async () => {
    const inner = new FakeTurnRunner(5);
    const queued = new QueuedTurnRunner(inner);
    const { rt } = makeRuntime({ runner: queued });
    const pipeline = makePipeline();
    const k = key();

    await Promise.all([
      pipeline.ingest(k, messageEvent(inboundMessage('wamid.a', 'first', k, 1)), rt),
      pipeline.ingest(k, messageEvent(inboundMessage('wamid.b', 'second', k, 2)), rt),
    ]);

    expect(inner.turns).toEqual(['first', 'second']);
  });

  test('stale in-progress claim can replay after DO eviction without double turn', async () => {
    const { sql } = makeSql();
    const ledger = new SqlInboundLedger(sql, { inProgressTtlMs: 0 });
    const fake = new FakeTurnRunner();
    const sender = new FakeSender();
    const { rt } = makeRuntime({ ledger, runner: fake, sender });
    const pipeline = makePipeline();
    const k = key();
    const event = messageEvent(inboundMessage('wamid.evicted', 'resume me', k));

    expect(await ledger.claim(k, event.id)).toBe('claimed');
    await ledger.append(k, event);
    await pipeline.flush(k, rt);

    expect(fake.turns).toEqual(['resume me']);
    expect(sender.texts).toEqual(['reply:resume me']);
  });

  test('two phoneNumberIds with same from are isolated', async () => {
    const fake = new FakeTurnRunner();
    const { rt } = makeRuntime({ runner: fake });
    const pipeline = makePipeline();
    const firstKey = key('PNID_A', '15551234567');
    const secondKey = key('PNID_B', '15551234567');

    await pipeline.ingest(firstKey, messageEvent(inboundMessage('same-id', 'tenant A', firstKey)), rt);
    await pipeline.ingest(secondKey, messageEvent(inboundMessage('same-id', 'tenant B', secondKey)), rt);

    expect(fake.turns).toEqual(['tenant A', 'tenant B']);
  });

  test('image message resolves to text plus file input through shared media middleware', async () => {
    const fake = new FakeTurnRunner();
    const media: MediaResolver = {
      async resolve(_message, input) {
        return [
          ...(typeof input === 'string' && input ? [{ type: 'text' as const, text: input }] : []),
          {
            type: 'file' as const,
            data: Buffer.from('PRESCRIPTION_BYTES').toString('base64'),
            mediaType: 'image/jpeg',
            filename: 'rx.jpg',
          },
        ];
      },
    };
    const { rt } = makeRuntime({ runner: fake, media });
    const pipeline = makePipeline();
    const k = key();
    const message = {
      ...inboundMessage('wamid.image', 'here is my rx', k),
      type: 'image' as const,
      media: { id: 'MEDIA123', mimeType: 'image/jpeg', caption: 'here is my rx' },
    };

    await pipeline.ingest(k, messageEvent(message), rt);

    expect(fake.turns).toEqual(['here is my rx\n[file:image/jpeg]']);
  });
});

describe('checkout token codec (WhatsApp carries the wa-id)', () => {
  test('encode/decode round-trips the wa-id + signal id', () => {
    const token = encodeCheckoutToken({ doId: '15551234567', signalId: 'sig-1' });
    expect(decodeCheckoutToken(token)).toEqual({ doId: '15551234567', signalId: 'sig-1' });
  });
});
