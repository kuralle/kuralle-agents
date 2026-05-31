import { describe, expect, it } from 'bun:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const SIP = require('node.js-sip/SIP/index.js') as {
  Parser: {
    parse: (raw: string) => Record<string, unknown>;
  };
};

function buildMessage(method: 'INVITE' | 'ACK' | 'BYE', cseq: number): string {
  return [
    `${method} sip:agent@127.0.0.1 SIP/2.0`,
    'Via: SIP/2.0/UDP 127.0.0.1:5060;branch=z9hG4bK1234',
    'From: <sip:caller@127.0.0.1>;tag=fromtag',
    'To: <sip:agent@127.0.0.1>',
    'Call-ID: call-123',
    `CSeq: ${cseq} ${method}`,
    'Contact: <sip:caller@127.0.0.1:5060>',
    'Content-Length: 0',
    '',
    '',
  ].join('\r\n');
}

describe('SIP protocol fixtures', () => {
  it('parses INVITE fixture', () => {
    const parsed = SIP.Parser.parse(buildMessage('INVITE', 1));
    expect(parsed.method).toBe('INVITE');
  });

  it('parses ACK fixture', () => {
    const parsed = SIP.Parser.parse(buildMessage('ACK', 2));
    expect(parsed.method).toBe('ACK');
  });

  it('parses BYE fixture', () => {
    const parsed = SIP.Parser.parse(buildMessage('BYE', 3));
    expect(parsed.method).toBe('BYE');
  });
});
