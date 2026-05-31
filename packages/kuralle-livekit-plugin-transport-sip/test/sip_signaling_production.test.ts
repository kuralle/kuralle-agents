import { describe, expect, it } from 'bun:test';
import { createRequire } from 'node:module';
import { SIPSignaling } from '../src/sip_signaling.js';
import { getSIPSignalingTestState } from './signaling-test-access.js';

const require = createRequire(import.meta.url);
const SIP = require('node.js-sip/SIP/index.js') as {
  Parser: {
    parse: (raw: string) => unknown;
  };
};

function buildInvite(callId = 'call-123'): unknown {
  const raw = [
    'INVITE sip:agent@127.0.0.1 SIP/2.0',
    'Via: SIP/2.0/UDP 192.0.2.10:5060;branch=z9hG4bK1234;rport',
    'From: "Caller" <sip:caller@example.com>;tag=fromtag',
    'To: <sip:agent@127.0.0.1>',
    `Call-ID: ${callId}`,
    'CSeq: 42 INVITE',
    'Contact: <sip:caller@192.0.2.10:5060>',
    'Content-Type: application/sdp',
    'Content-Length: 66',
    '',
    [
      'v=0',
      'o=- 1 1 IN IP4 192.0.2.10',
      's=-',
      'c=IN IP4 192.0.2.10',
      't=0 0',
      'm=audio 4000 RTP/AVP 0 8',
      'a=rtpmap:0 PCMU/8000',
      'a=rtpmap:8 PCMA/8000',
    ].join('\r\n'),
  ].join('\r\n');

  return SIP.Parser.parse(raw);
}

function buildCancel(callId = 'call-123'): unknown {
  const raw = [
    'CANCEL sip:agent@127.0.0.1 SIP/2.0',
    'Via: SIP/2.0/UDP 192.0.2.10:5060;branch=z9hG4bK1234;rport',
    'From: "Caller" <sip:caller@example.com>;tag=fromtag',
    'To: <sip:agent@127.0.0.1>',
    `Call-ID: ${callId}`,
    'CSeq: 42 CANCEL',
    'Content-Length: 0',
    '',
    '',
  ].join('\r\n');

  return SIP.Parser.parse(raw);
}

function buildOptions(callId = 'call-options'): unknown {
  const raw = [
    'OPTIONS sip:agent@127.0.0.1 SIP/2.0',
    'Via: SIP/2.0/UDP 192.0.2.20:5070;branch=z9hG4bKopts;rport',
    'From: <sip:probe@example.com>;tag=optstag',
    'To: <sip:agent@127.0.0.1>',
    `Call-ID: ${callId}`,
    'CSeq: 7 OPTIONS',
    'Content-Length: 0',
    '',
    '',
  ].join('\r\n');

  return SIP.Parser.parse(raw);
}

function createHarness() {
  const signaling = new SIPSignaling({
    localAddress: '127.0.0.1',
    sipPort: 5060,
  });
  const state = getSIPSignalingTestState(signaling);

  const sent: Array<{ wire: string; host: string; port: number }> = [];
  state.voip = {
    transport: {
      send: (wire: string, host: string, port: number) => {
        sent.push({ wire, host, port });
      },
      socket: {
        close: () => {},
      },
    },
  };

  return { signaling, state, sent };
}

describe('SIPSignaling production transaction behavior', () => {
  it('sends provisional and final responses only after bootstrap succeeds', async () => {
    const { signaling, state, sent } = createHarness();
    let inviteArgs: unknown[] | null = null;
    state.onInviteCallback = async (...args: unknown[]) => {
      inviteArgs = args;
    };

    const invite = buildInvite();
    await state.handleInviteRequest(invite, 'call-123');

    expect(inviteArgs).toBeTruthy();
    expect(sent.length).toBe(3);
    expect(sent[0]!.wire).toContain('SIP/2.0 100 Trying');
    expect(sent[1]!.wire).toContain('SIP/2.0 180 Ringing');
    expect(sent[1]!.wire).toContain('To: <sip:agent@127.0.0.1>;tag=');
    expect(sent[2]!.wire).toContain('SIP/2.0 200 OK');
    expect(sent[2]!.wire).toContain('m=audio 10000 RTP/AVP 0');

    const activeCall = state.activeCalls.get('call-123');
    expect(activeCall).toBeTruthy();
    expect(activeCall!.remoteTag).toBe('fromtag');
    expect(activeCall!.remoteTargetUri).toBe('sip:caller@192.0.2.10:5060');
    expect(activeCall!.responseHost).toBe('192.0.2.10');
    expect(activeCall!.responsePort).toBe(5060);
    expect(state.pendingInvites.size).toBe(0);
  });

  it('sends a dialog-correct BYE with preserved tags and request target', async () => {
    const { signaling, state, sent } = createHarness();
    state.onInviteCallback = async () => {};

    const invite = buildInvite();
    await state.handleInviteRequest(invite, 'call-123');
    await signaling.hangup('call-123');

    expect(sent.length).toBe(4);
    const bye = sent[3]!;
    expect(bye.host).toBe('192.0.2.10');
    expect(bye.port).toBe(5060);
    expect(bye.wire).toContain('BYE sip:caller@192.0.2.10:5060 SIP/2.0');
    expect(bye.wire).toContain('To: <sip:caller@example.com>;tag=fromtag');
    expect(bye.wire).toContain('From: <sip:agent@127.0.0.1>;tag=');
    expect(bye.wire).toContain('Call-ID: call-123');
    expect(bye.wire).toContain('CSeq: 1 BYE');
  });

  it('rejects the INVITE with 500 when bootstrap fails', async () => {
    const { state, sent } = createHarness();
    state.onInviteCallback = async () => {
      throw new Error('bootstrap failed');
    };

    const invite = buildInvite('call-fail');
    await expect(
      state.handleInviteRequest(invite, 'call-fail'),
    ).rejects.toThrow('bootstrap failed');

    expect(sent.length).toBe(3);
    expect(sent[0]!.wire).toContain('SIP/2.0 100 Trying');
    expect(sent[1]!.wire).toContain('SIP/2.0 180 Ringing');
    expect(sent[2]!.wire).toContain('SIP/2.0 500 Server Internal Error');
    expect(state.activeCalls.has('call-fail')).toBe(false);
    expect(state.pendingInvites.has('call-fail')).toBe(false);
  });

  it('handles CANCEL by sending 200 to CANCEL and 487 to the pending INVITE', async () => {
    const { state, sent } = createHarness();
    let cleanupCallId = '';
    const control: { releaseInvite?: () => void } = {};
    state.onInviteCallback = async () =>
      await new Promise<void>((resolve) => {
        control.releaseInvite = resolve;
      });
    state.onByeCallback = async (callId: string) => {
      cleanupCallId = callId;
    };

    const invitePromise = state.handleInviteRequest(
      buildInvite('call-cancel'),
      'call-cancel',
    );

    await Promise.resolve();

    expect(sent.length).toBe(2);
    expect(sent[0]!.wire).toContain('SIP/2.0 100 Trying');
    expect(sent[1]!.wire).toContain('SIP/2.0 180 Ringing');

    await state.handleCancelRequest(
      buildCancel('call-cancel'),
      'call-cancel',
    );

    expect(sent.length).toBe(4);
    expect(sent[2]!.wire).toContain('SIP/2.0 200 OK');
    expect(sent[3]!.wire).toContain('SIP/2.0 487 Request Terminated');
    expect(cleanupCallId).toBe('call-cancel');
    expect(state.pendingInvites.has('call-cancel')).toBe(false);

    const resolveInvite = control.releaseInvite;
    if (resolveInvite) {
      resolveInvite();
    }
    await invitePromise;

    expect(state.activeCalls.has('call-cancel')).toBe(false);
  });

  it('responds to OPTIONS with explicit allow headers', () => {
    const { state, sent } = createHarness();

    state.handleOptionsRequest(buildOptions());

    expect(sent.length).toBe(1);
    expect(sent[0]!.wire).toContain('SIP/2.0 200 OK');
    expect(sent[0]!.wire).toContain('Allow: INVITE, ACK, BYE, CANCEL, OPTIONS');
    expect(sent[0]!.wire).toContain('Accept: application/sdp');
  });
});
