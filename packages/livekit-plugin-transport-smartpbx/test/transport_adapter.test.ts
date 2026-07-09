import { describe, expect, it } from 'bun:test';
import { initializeLogger } from '@livekit/agents';
import { AudioFrame } from '@kuralle-agents/livekit-plugin';
import {
  SmartPBXTransportAdapter,
  DEFAULT_SMARTPBX_SAMPLE_RATE,
  DEFAULT_WEBSOCKET_OPEN_STATE,
} from '../src/index.js';

initializeLogger({ pretty: false, level: 'warn' });

function createSocket(readyState: number = DEFAULT_WEBSOCKET_OPEN_STATE) {
  const sent: string[] = [];
  return {
    readyState,
    sent,
    send: (payload: string) => {
      sent.push(payload);
    },
  };
}

describe('SmartPBXTransportAdapter', () => {
  it('surfaces assistant text through host callback, not SmartPBX protocol messages', async () => {
    const socket = createSocket();
    const session = { callId: 'call-1', accountId: 'acct-1', isActive: true };
    const texts: Array<{ text: string; callId: string }> = [];
    const adapter = new SmartPBXTransportAdapter({
      socket,
      session,
      onText: (text, currentSession) => {
        texts.push({ text, callId: currentSession.callId });
      },
    });

    await adapter.textOutput.captureText('hello caller');

    expect(socket.sent.length).toBe(0);
    expect(texts).toEqual([{ text: 'hello caller', callId: 'call-1' }]);
  });

  it('does not emit SmartPBX protocol messages on local turn end', () => {
    const socket = createSocket();
    const session = { callId: 'call-2', accountId: 'acct-2', isActive: true };
    const adapter = new SmartPBXTransportAdapter({ socket, session });

    adapter.audioInput.endCurrentTurn();

    expect(socket.sent.length).toBe(0);
  });

  it('forwards outbound audio frames through onAudioFrame callback', async () => {
    const socket = createSocket();
    const session = { callId: 'call-3', accountId: 'acct-3', isActive: true };

    let callbackCount = 0;
    let lastLength = 0;

    const adapter = new SmartPBXTransportAdapter({
      socket,
      session,
      onAudioFrame: (frame) => {
        callbackCount += 1;
        lastLength = frame.length;
      },
    });

    await adapter.audioOutput.captureFrame(
      new AudioFrame(
        new Int16Array([0, 1024, -1024]),
        DEFAULT_SMARTPBX_SAMPLE_RATE,
        1,
        3,
      ),
    );

    expect(callbackCount).toBe(1);
    expect(lastLength).toBe(3);
  });

  it('only signals playback lifecycle after successful outbound delivery', async () => {
    const socket = createSocket();
    const session = { callId: 'call-lifecycle', accountId: 'acct-lifecycle', isActive: true };

    let playbackStarted = 0;
    let playbackFinished: { playbackPosition: number; interrupted: boolean; synchronizedTranscript?: string } | null = null;

    const adapter = new SmartPBXTransportAdapter({
      socket,
      session,
      onAudioFrame: () => {},
    });

    adapter.audioOutput.onPlaybackStarted = () => {
      playbackStarted += 1;
    };
    adapter.audioOutput.onPlaybackFinished = (event) => {
      playbackFinished = event;
    };

    await adapter.audioOutput.captureFrame(
      new AudioFrame(
        new Int16Array([0, 1024, -1024]),
        DEFAULT_SMARTPBX_SAMPLE_RATE,
        1,
        3,
      ),
    );

    adapter.audioOutput.flush();

    expect(playbackStarted).toBe(1);
    expect(playbackFinished).not.toBeNull();
    const finished = playbackFinished!;
    expect(finished.interrupted).toBe(false);
    expect(finished.playbackPosition).toBeCloseTo(3 / DEFAULT_SMARTPBX_SAMPLE_RATE);
  });

  it('does not forward outbound audio when session is inactive', async () => {
    const socket = createSocket();
    const session = { callId: 'call-4', accountId: 'acct-4', isActive: false };

    let callbackCount = 0;
    let playbackStarted = 0;

    const adapter = new SmartPBXTransportAdapter({
      socket,
      session,
      onAudioFrame: () => {
        callbackCount += 1;
      },
    });
    adapter.audioOutput.onPlaybackStarted = () => {
      playbackStarted += 1;
    };

    await adapter.audioOutput.captureFrame(
      new AudioFrame(
        new Int16Array([1, 2]),
        DEFAULT_SMARTPBX_SAMPLE_RATE,
        1,
        2,
      ),
    );

    expect(callbackCount).toBe(0);
    expect(playbackStarted).toBe(0);
  });

  it('does not signal playback lifecycle when socket is closed', async () => {
    const socket = createSocket(3);
    const session = { callId: 'call-closed', accountId: 'acct-closed', isActive: true };

    let callbackCount = 0;
    let playbackStarted = 0;

    const adapter = new SmartPBXTransportAdapter({
      socket,
      session,
      onAudioFrame: () => {
        callbackCount += 1;
      },
    });
    adapter.audioOutput.onPlaybackStarted = () => {
      playbackStarted += 1;
    };

    await adapter.audioOutput.captureFrame(
      new AudioFrame(
        new Int16Array([1, 2]),
        DEFAULT_SMARTPBX_SAMPLE_RATE,
        1,
        2,
      ),
    );

    expect(callbackCount).toBe(0);
    expect(playbackStarted).toBe(0);
  });

  it('does not surface assistant text when session is inactive', async () => {
    const socket = createSocket();
    const session = { callId: 'call-text-inactive', accountId: 'acct-text-inactive', isActive: false };
    let callbackCount = 0;
    const adapter = new SmartPBXTransportAdapter({
      socket,
      session,
      onText: () => {
        callbackCount += 1;
      },
    });

    await adapter.textOutput.captureText('should not send');

    expect(socket.sent.length).toBe(0);
    expect(callbackCount).toBe(0);
  });

  it('reflects live session/socket state in isOpen', () => {
    const socket = createSocket();
    const session = { callId: 'call-5', accountId: 'acct-5', isActive: true };
    const adapter = new SmartPBXTransportAdapter({ socket, session });

    expect(adapter.isOpen).toBe(true);

    session.isActive = false;
    expect(adapter.isOpen).toBe(false);

    session.isActive = true;
    socket.readyState = 3;
    expect(adapter.isOpen).toBe(false);
  });
});
