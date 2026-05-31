import type { RTCSession } from 'jssip/lib/RTCSession.js';

export interface JsSIPSignalingOptions {
  localAddress: string;
  wsServerHost?: string;
  wsServerPort?: number;
  secureWebSocket?: boolean;
  sipUsername?: string;
  sipPassword?: string;
  sipDomain?: string;
  shouldRegister?: boolean;
}

export type OnSessionCallback = (callId: string, session: RTCSession) => void;
export type OnByeCallback = (callId: string) => void;
