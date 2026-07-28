import { describe, expect, it } from 'bun:test';
import type { SignalDelivery } from '@kuralle-agents/core';
import { InMemoryWindowStore } from '../src/adapter/window-store.js';
import { InMemoryInboundLedger } from '../src/inbound/ledger.js';
import { createInboundPipeline, runTurn } from '../src/inbound/pipeline.js';
import { noopCoalesceScheduler, systemClock } from '../src/inbound/ports.js';
import type { InboundRuntime } from '../src/inbound/types.js';

describe('messaging signal delivery', () => {
  it('preserves interrupt identity and authenticated actor through the inbound pipeline', async () => {
    const delivery: SignalDelivery = {
      signalId: 'signal-1',
      requestId: 'approval-request-1',
      name: '__approval',
      actor: { id: 'owner-1', type: 'user' },
      decision: 'approve',
    };
    let received: SignalDelivery | undefined;
    const runtime: InboundRuntime = {
      ledger: new InMemoryInboundLedger(),
      window: new InMemoryWindowStore(),
      media: { resolve: async (_message, input) => input },
      sender: { send: async () => {} },
      runtime: {
        runTurn: async () => ({ parts: [] }),
        deliverSignal: async ({ signal }) => {
          received = signal;
          return {
            parts: [],
            suspended: {
              requestId: 'next-request',
              signalName: 'payment_confirmed',
            },
          };
        },
      },
      scheduler: noopCoalesceScheduler,
      clock: systemClock,
    };
    const key = { platform: 'whatsapp', businessId: 'business-1', threadId: 'thread-1' };

    const outcome = await createInboundPipeline([runTurn()]).ingest(
      key,
      { kind: 'signal', id: 'event-1', ts: 1, data: delivery },
      runtime,
    );

    expect(received).toEqual(delivery);
    expect(outcome).toEqual({
      kind: 'suspended',
      requestId: 'next-request',
      signalName: 'payment_confirmed',
    });
  });
});
