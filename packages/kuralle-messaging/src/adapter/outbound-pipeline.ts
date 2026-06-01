import type {
  OutboundMiddleware,
  OutboundRequest,
  OutboundSink,
  SendOutcome,
} from '../types/outbound.js';
import { isTagCapable } from '../types/outbound.js';

const WINDOW_GUARD = 'window-guard';

export class OutboundPipeline {
  constructor(
    private readonly mw: OutboundMiddleware[],
    private readonly sink: OutboundSink,
  ) {
    const idx = mw.findIndex((m) => m.name === WINDOW_GUARD);
    if (idx === -1) {
      throw new Error('window-guard middleware is required (window safety)');
    }
    if (idx !== mw.length - 1) {
      throw new Error('window-guard must be terminal (the last middleware before the sink)');
    }
  }

  send(req: OutboundRequest): Promise<SendOutcome> {
    const run = (i: number, r: OutboundRequest): Promise<SendOutcome> =>
      i < this.mw.length
        ? this.mw[i].send(r, (nr: OutboundRequest) => run(i + 1, nr))
        : this.terminal(r);
    return run(0, req);
  }

  private async terminal(r: OutboundRequest): Promise<SendOutcome> {
    const { payload, threadId } = r;
    switch (payload.kind) {
      case 'text':
        if (payload.tag && isTagCapable(this.sink)) {
          return {
            kind: 'sent',
            result: await this.sink.sendTextWithTag(threadId, payload.text, payload.tag),
          };
        }
        return { kind: 'sent', result: await this.sink.sendText(threadId, payload.text) };
      case 'interactive':
        return {
          kind: 'sent',
          result: await this.sink.sendInteractive(threadId, payload.interactive),
        };
      case 'media':
        return { kind: 'sent', result: await this.sink.sendMedia(threadId, payload.media) };
      case 'template': {
        if (typeof this.sink.sendTemplate !== 'function') {
          throw new Error('sink has no template capability');
        }
        return {
          kind: 'sent',
          result: await this.sink.sendTemplate(threadId, payload.template),
        };
      }
    }
  }
}
