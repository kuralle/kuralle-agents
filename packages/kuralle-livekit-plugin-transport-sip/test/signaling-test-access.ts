import type { JsSIPSignaling } from '../src/jssip/jssip_signaling.js';
import type { SIPAgentServer } from '../src/server.js';
import type { SIPSignaling } from '../src/sip_signaling.js';

export type SIPSignalingTestState = {
  voip: {
    transport: {
      send: (wire: string, host: string, port: number) => void;
      socket?: { close: () => void };
    };
  } | null;
  activeCalls: Map<string, Record<string, unknown>>;
  pendingInvites: Map<string, unknown>;
  ready: boolean;
  onInviteCallback: (...args: unknown[]) => Promise<void>;
  onByeCallback?: (callId: string) => Promise<void>;
  handleInviteRequest: (invite: unknown, callId: string) => Promise<void>;
  handleCancelRequest: (cancel: unknown, callId: string) => Promise<void>;
  handleOptionsRequest: (options: unknown) => void;
};

export function getSIPSignalingTestState(signaling: SIPSignaling): SIPSignalingTestState {
  // @ts-expect-error — test-only cast to access private fields
  return signaling as SIPSignalingTestState;
}

export type JsSIPSignalingTestState = {
  ua: {
    status: number;
    isRegistered: () => boolean;
    stop?: () => void;
  } | null;
  activeSessions: Map<string, { terminate: () => Promise<void> }>;
};

export function getJsSIPSignalingTestState(signaling: JsSIPSignaling): JsSIPSignalingTestState {
  // @ts-expect-error — test-only cast to access private fields
  return signaling as JsSIPSignalingTestState;
}

export type SIPAgentServerTestState = {
  signaling: Partial<{
    hangup: (callId: string) => Promise<void>;
    stop: () => Promise<void>;
    getRtpPort: () => number | undefined;
  }>;
  sessionManager: Partial<{
    closeAll: () => Promise<void>;
  }>;
};

export function getSIPAgentServerTestState(server: SIPAgentServer): SIPAgentServerTestState {
  // @ts-expect-error — test-only cast to access private fields
  return server as SIPAgentServerTestState;
}
