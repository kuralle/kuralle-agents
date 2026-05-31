import WebSocket from 'ws';
import { AudioFrame } from '@livekit/rtc-node';
import { llm } from '@livekit/agents';
import { LiveKitSessionRunner, type NativeAudioTransport } from '@kuralle-agents/livekit-plugin';
import { createWsNativeAudioTransport } from './native_bridge.js';

export interface LiveKitWsBridgeOptions {
  /** Session ID. Auto-generated if not provided. */
  sessionId?: string;
  /** Sample rate for the config message. Default: 24000. */
  sampleRate?: number;
  /** Number of channels. Default: 1. */
  numChannels?: number;
  /** Called when a tool is executed. */
  onToolResult?: (
    toolName: string,
    args: unknown,
    result: unknown,
    success: boolean,
  ) => void;
  /** Called when the session ends (WS close, error, external stop, or attach failure after partial setup). */
  onSessionEnd?: (reason: string) => void;
}

export interface LiveKitWsBridgeHandle {
  readonly sessionId: string;
  stop(): Promise<void>;
}

/** Duck-typed LiveKit realtime session — accepts any object satisfying the wire shape below. */
export type LiveKitRealtimeSessionWire = {
  on(event: string, handler: (...args: unknown[]) => void): unknown;
  chatCtx: llm.ChatContext;
  tools?: llm.ToolContext;
  pushAudio(frame: AudioFrame): void;
  updateChatCtx(chatCtx: llm.ChatContext): Promise<void>;
  close(): Promise<void>;
};

export type LiveKitRealtimeAdapterWire = {
  attach(session: LiveKitRealtimeSessionWire): Promise<void>;
  detach(): Promise<void>;
  onTurnComplete(): Promise<void>;
};

export async function bridgeLiveKitSessionToWebSocket(
  ws: WebSocket,
  session: LiveKitRealtimeSessionWire,
  adapter: LiveKitRealtimeAdapterWire,
  options?: LiveKitWsBridgeOptions,
): Promise<LiveKitWsBridgeHandle> {
  let stopped = false;
  const sampleRate = options?.sampleRate ?? 24000;
  const numChannels = options?.numChannels ?? 1;

  function sendJson(payload: Record<string, unknown>): void {
    if (ws.readyState !== WebSocket.OPEN) return;
    try {
      ws.send(JSON.stringify(payload));
    } catch {
      /* WS closed */
    }
  }

  const baseTransport = createWsNativeAudioTransport(ws);
  const transport: NativeAudioTransport = {
    sendAudio: (d) => baseTransport.sendAudio(d),
    onAudio: (h) => baseTransport.onAudio(h),
    onClose: (h) =>
      baseTransport.onClose(() => {
        stopped = true;
        h();
      }),
    close: () => baseTransport.close(),
  };
  const runner = new LiveKitSessionRunner({
    session,
    adapter,
    transport,
    sessionId: options?.sessionId,
    sampleRate,
    numChannels,
    onToolResult: (toolName, args, result, success) => {
      sendJson({ type: 'tool_result', toolName, success });
      options?.onToolResult?.(toolName, args, result, success);
    },
    onTurnComplete: () => sendJson({ type: 'turn_complete' }),
    onTurnCompleteError: () => sendJson({ type: 'turn_complete', error: true }),
    onUserTranscript: (text) =>
      sendJson({
        type: 'user_transcription',
        text,
        isFinal: true,
      }),
    onSessionEnd: options?.onSessionEnd,
  });

  try {
    await runner.start();
  } catch (err) {
    stopped = true;
    try {
      if (ws.readyState === WebSocket.OPEN) ws.close(4000, 'Failed');
    } catch {
      /* ignore */
    }
    throw err;
  }

  sendJson({
    type: 'session_started',
    sessionId: runner.sessionId,
    config: { sampleRate, numChannels },
  });

  ws.on('error', () => {
    void runner.stop('ws_error');
  });

  return {
    sessionId: runner.sessionId,
    stop: async () => {
      if (stopped) return;
      stopped = true;
      await runner.stop('external_stop');
      try {
        if (ws.readyState === WebSocket.OPEN) ws.close(1000);
      } catch {
        /* ignore */
      }
    },
  };
}
