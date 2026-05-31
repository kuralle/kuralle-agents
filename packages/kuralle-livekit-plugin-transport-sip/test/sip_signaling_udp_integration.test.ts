import { afterEach, describe, expect, it } from 'bun:test';
import dgram from 'node:dgram';
import { SIPSignaling } from '../src/sip_signaling.js';

interface ReceivedMessage {
  text: string;
  address: string;
  port: number;
}

const openSockets = new Set<dgram.Socket>();

function createUdpSocket(): dgram.Socket {
  const socket = dgram.createSocket('udp4');
  openSockets.add(socket);
  socket.on('close', () => {
    openSockets.delete(socket);
  });
  return socket;
}

async function bindSocket(socket: dgram.Socket, port: number): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    socket.once('error', reject);
    socket.bind(port, '127.0.0.1', () => {
      socket.off('error', reject);
      resolve();
    });
  });
}

function waitForMessages(
  store: ReceivedMessage[],
  count: number,
  timeoutMs = 3000,
): Promise<ReceivedMessage[]> {
  return new Promise((resolve, reject) => {
    const started = Date.now();

    const tick = () => {
      if (store.length >= count) {
        resolve(store.slice(0, count));
        return;
      }
      if (Date.now() - started >= timeoutMs) {
        reject(
          new Error(
            `Timed out waiting for ${count} messages; received ${store.length}`,
          ),
        );
        return;
      }
      setTimeout(tick, 10);
    };

    tick();
  });
}

function closeSocket(socket: dgram.Socket): Promise<void> {
  return new Promise((resolve) => {
    try {
      socket.close(() => resolve());
    } catch {
      resolve();
    }
  });
}

function buildInvite(callId: string, clientPort: number): string {
  const sdp = [
    'v=0',
    'o=- 1 1 IN IP4 127.0.0.1',
    's=-',
    'c=IN IP4 127.0.0.1',
    't=0 0',
    'm=audio 4000 RTP/AVP 0 8',
    'a=rtpmap:0 PCMU/8000',
    'a=rtpmap:8 PCMA/8000',
  ].join('\r\n');

  return [
    'INVITE sip:agent@127.0.0.1 SIP/2.0',
    `Via: SIP/2.0/UDP 127.0.0.1:${clientPort};branch=z9hG4bKinvite;rport`,
    'From: <sip:caller@example.com>;tag=fromtag',
    'To: <sip:agent@127.0.0.1>',
    `Call-ID: ${callId}`,
    'CSeq: 42 INVITE',
    `Contact: <sip:caller@127.0.0.1:${clientPort}>`,
    'Content-Type: application/sdp',
    `Content-Length: ${sdp.length}`,
    '',
    sdp,
  ].join('\r\n');
}

function buildCancel(callId: string, clientPort: number): string {
  return [
    'CANCEL sip:agent@127.0.0.1 SIP/2.0',
    `Via: SIP/2.0/UDP 127.0.0.1:${clientPort};branch=z9hG4bKinvite;rport`,
    'From: <sip:caller@example.com>;tag=fromtag',
    'To: <sip:agent@127.0.0.1>',
    `Call-ID: ${callId}`,
    'CSeq: 42 CANCEL',
    'Content-Length: 0',
    '',
    '',
  ].join('\r\n');
}

function buildBye(callId: string, clientPort: number, localTag: string): string {
  return [
    'BYE sip:agent@127.0.0.1 SIP/2.0',
    `Via: SIP/2.0/UDP 127.0.0.1:${clientPort};branch=z9hG4bKbye;rport`,
    'From: <sip:caller@example.com>;tag=fromtag',
    `To: <sip:agent@127.0.0.1>;tag=${localTag}`,
    `Call-ID: ${callId}`,
    'CSeq: 43 BYE',
    `Contact: <sip:caller@127.0.0.1:${clientPort}>`,
    'Content-Length: 0',
    '',
    '',
  ].join('\r\n');
}

afterEach(async () => {
  await Promise.allSettled(Array.from(openSockets).map((socket) => closeSocket(socket)));
});

describe('SIPSignaling UDP integration', () => {
  it('handles pending and established dialog flows over real UDP', async () => {
    const basePort = 43000 + ((process.pid + Math.floor(Math.random() * 100)) % 500) * 4;
    const cancelClientPort = basePort;
    const inviteClientPort = basePort + 2;
    const serverPort = basePort + 1;
    const cancelCallId = 'call-udp-cancel';
    const inviteCallId = 'call-udp-1';
    const cancelReceived: ReceivedMessage[] = [];
    const inviteReceived: ReceivedMessage[] = [];
    let releaseInvite: (() => void) | undefined;

    const cancelClient = createUdpSocket();
    cancelClient.on('message', (msg, rinfo) => {
      cancelReceived.push({
        text: msg.toString(),
        address: rinfo.address,
        port: rinfo.port,
      });
    });
    await bindSocket(cancelClient, cancelClientPort);

    const inviteClient = createUdpSocket();
    inviteClient.on('message', (msg, rinfo) => {
      inviteReceived.push({
        text: msg.toString(),
        address: rinfo.address,
        port: rinfo.port,
      });
    });
    await bindSocket(inviteClient, inviteClientPort);

    const signaling = new SIPSignaling({
      localAddress: '127.0.0.1',
      sipPort: serverPort,
    });

    try {
      await signaling.start(
        async (callId) => {
          if (callId === cancelCallId) {
            await new Promise<void>((resolve) => {
              releaseInvite = resolve;
            });
          }
        },
      );

      cancelClient.send(
        Buffer.from(buildInvite(cancelCallId, cancelClientPort)),
        serverPort,
        '127.0.0.1',
      );

      const provisional = await waitForMessages(cancelReceived, 2, 8000);
      expect(provisional[0]!.text).toContain('SIP/2.0 100 Trying');
      expect(provisional[1]!.text).toContain('SIP/2.0 180 Ringing');

      cancelClient.send(
        Buffer.from(buildCancel(cancelCallId, cancelClientPort)),
        serverPort,
        '127.0.0.1',
      );

      const cancelResponses = await waitForMessages(cancelReceived, 4, 8000);
      expect(cancelResponses[2]!.text).toContain('SIP/2.0 200 OK');
      expect(cancelResponses[2]!.text).toContain('CSeq: 42 CANCEL');
      expect(cancelResponses[3]!.text).toContain('SIP/2.0 487 Request Terminated');
      expect(cancelResponses[3]!.text).toContain('CSeq: 42 INVITE');

      releaseInvite?.();
      await Promise.resolve();

      inviteClient.send(
        Buffer.from(buildInvite(inviteCallId, inviteClientPort)),
        serverPort,
        '127.0.0.1',
      );

      const inviteResponses = await waitForMessages(inviteReceived, 3, 8000);
      expect(inviteResponses[0]!.text).toContain('SIP/2.0 100 Trying');
      expect(inviteResponses[1]!.text).toContain('SIP/2.0 180 Ringing');
      expect(inviteResponses[2]!.text).toContain('SIP/2.0 200 OK');

      const localTagMatch = inviteResponses[2]!.text.match(
        /To:\s*<sip:agent@127\.0\.0\.1>;tag=([^\r\n;]+)/i,
      );
      expect(localTagMatch?.[1]).toBeTruthy();
      const localTag = localTagMatch![1];

      inviteClient.send(
        Buffer.from(buildBye(inviteCallId, inviteClientPort, localTag)),
        serverPort,
        '127.0.0.1',
      );

      const allResponses = await waitForMessages(inviteReceived, 4, 8000);
      expect(allResponses[3]!.text).toContain('SIP/2.0 200 OK');
      expect(allResponses[3]!.text).toContain('CSeq: 43 BYE');
    } finally {
      await signaling.stop();
    }
  }, 30_000);
});
