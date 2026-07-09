import { useEffect, useRef, useCallback } from "react";
import {
  KuralleAnalytics,
  createAnalyticsClient,
  type AnalyticsConfig,
  type AnalyticsEvent,
  type AnalyticsContext,
  type VoiceCallData,
} from "./index.js";

export interface UseAnalyticsOptions extends AnalyticsConfig {
  autoFlush?: boolean;
}

let globalClient: KuralleAnalytics | null = null;

export function initAnalytics(config: AnalyticsConfig): KuralleAnalytics {
  if (globalClient) {
    globalClient.destroy();
  }
  globalClient = createAnalyticsClient(config) as KuralleAnalytics;
  return globalClient;
}

export function getAnalyticsClient(): KuralleAnalytics | null {
  return globalClient;
}

export function useAnalytics(config?: UseAnalyticsOptions): {
  track: (event: AnalyticsEvent) => Promise<void>;
  trackBatch: (events: AnalyticsEvent[]) => Promise<void>;
  trackVoiceCall: (data: VoiceCallData) => Promise<void>;
  updateVoiceCall: (sessionId: string, data: Partial<VoiceCallData>) => Promise<void>;
  flush: () => Promise<void>;
  setContext: (context: Partial<AnalyticsContext>) => void;
  identify: (userId: string, traits?: Record<string, unknown>) => void;
} {
  const clientRef = useRef<KuralleAnalytics | null>(null);

  useEffect(() => {
    if (config && !clientRef.current) {
      clientRef.current = createAnalyticsClient(config) as KuralleAnalytics;
    }

    return () => {
      if (clientRef.current) {
        clientRef.current.destroy();
        clientRef.current = null;
      }
    };
  }, [config]);

  const client = clientRef.current ?? globalClient;

  const track = useCallback(
    async (event: AnalyticsEvent) => {
      if (!client) {
        console.warn("[Analytics] Client not initialized");
        return;
      }
      await client.track(event);
    },
    [client]
  );

  const trackBatch = useCallback(
    async (events: AnalyticsEvent[]) => {
      if (!client) {
        console.warn("[Analytics] Client not initialized");
        return;
      }
      await client.trackBatch(events);
    },
    [client]
  );

  const trackVoiceCall = useCallback(
    async (data: VoiceCallData) => {
      if (!client) {
        console.warn("[Analytics] Client not initialized");
        return;
      }
      await client.trackVoiceCall(data);
    },
    [client]
  );

  const updateVoiceCall = useCallback(
    async (sessionId: string, data: Partial<VoiceCallData>) => {
      if (!client) {
        console.warn("[Analytics] Client not initialized");
        return;
      }
      await client.updateVoiceCall(sessionId, data);
    },
    [client]
  );

  const flush = useCallback(async () => {
    if (!client) {
      console.warn("[Analytics] Client not initialized");
      return;
    }
    await client.flush();
  }, [client]);

  const setContext = useCallback(
    (context: Partial<AnalyticsContext>) => {
      if (!client) {
        console.warn("[Analytics] Client not initialized");
        return;
      }
      client.setContext(context);
    },
    [client]
  );

  const identify = useCallback(
    (userId: string, traits?: Record<string, unknown>) => {
      if (!client) {
        console.warn("[Analytics] Client not initialized");
        return;
      }
      client.identify(userId, traits);
    },
    [client]
  );

  return {
    track,
    trackBatch,
    trackVoiceCall,
    updateVoiceCall,
    flush,
    setContext,
    identify,
  };
}

export function AnalyticsProvider({
  children,
  config,
}: {
  children: React.ReactNode;
  config: AnalyticsConfig;
}): React.ReactElement {
  useEffect(() => {
    initAnalytics(config);
    return () => {
      const client = getAnalyticsClient();
      if (client) {
        client.destroy();
      }
    };
  }, [config]);

  return children as React.ReactElement;
}

export function useTrackEvent(): (event: AnalyticsEvent) => Promise<void> {
  const { track } = useAnalytics();
  return track;
}

export function usePageView(pageName: string, properties?: Record<string, unknown>): void {
  const { track } = useAnalytics();

  useEffect(() => {
    track({
      type: "custom",
      sessionId: "",
      agentId: "",
      workspaceId: "",
      data: {
        event: "page_view",
        page: pageName,
        ...properties,
      },
    });
  }, [pageName, properties, track]);
}

export function useVoiceCallTracker(sessionId: string, workspaceId: string): {
  startCall: (agentId?: string) => Promise<void>;
  endCall: (outcome?: string, data?: Partial<VoiceCallData>) => Promise<void>;
  trackInterruption: () => void;
  trackUserSpeech: (durationMs: number) => void;
  trackAgentSpeech: (durationMs: number) => void;
} {
  const { trackVoiceCall, updateVoiceCall } = useAnalytics();
  const callDataRef = useRef<Partial<VoiceCallData>>({
    sessionId,
    workspaceId,
    userTurns: 0,
    agentTurns: 0,
    interruptions: 0,
    totalUserSpeechMs: 0,
    totalAgentSpeechMs: 0,
  });

  const startCall = useCallback(
    async (agentId?: string) => {
      const data: VoiceCallData = {
        sessionId,
        workspaceId,
        agentId,
        startedAt: new Date(),
      };

      callDataRef.current = {
        ...callDataRef.current,
        ...data,
      };

      await trackVoiceCall(data);
    },
    [sessionId, workspaceId, trackVoiceCall]
  );

  const endCall = useCallback(
    async (outcome?: string, additionalData?: Partial<VoiceCallData>) => {
      const data: Partial<VoiceCallData> = {
        endedAt: new Date(),
        outcome,
        ...callDataRef.current,
        ...additionalData,
      };

      if (data.startedAt && data.endedAt) {
        data.durationSeconds = Math.floor(
          (data.endedAt.getTime() - data.startedAt.getTime()) / 1000
        );
      }

      await updateVoiceCall(sessionId, data);
    },
    [sessionId, updateVoiceCall]
  );

  const trackInterruption = useCallback(() => {
    callDataRef.current.interruptions = (callDataRef.current.interruptions ?? 0) + 1;
    updateVoiceCall(sessionId, {
      interruptions: callDataRef.current.interruptions,
    });
  }, [sessionId, updateVoiceCall]);

  const trackUserSpeech = useCallback(
    (durationMs: number) => {
      callDataRef.current.userTurns = (callDataRef.current.userTurns ?? 0) + 1;
      callDataRef.current.totalUserSpeechMs =
        (callDataRef.current.totalUserSpeechMs ?? 0) + durationMs;

      updateVoiceCall(sessionId, {
        userTurns: callDataRef.current.userTurns,
        totalUserSpeechMs: callDataRef.current.totalUserSpeechMs,
      });
    },
    [sessionId, updateVoiceCall]
  );

  const trackAgentSpeech = useCallback(
    (durationMs: number) => {
      callDataRef.current.agentTurns = (callDataRef.current.agentTurns ?? 0) + 1;
      callDataRef.current.totalAgentSpeechMs =
        (callDataRef.current.totalAgentSpeechMs ?? 0) + durationMs;

      updateVoiceCall(sessionId, {
        agentTurns: callDataRef.current.agentTurns,
        totalAgentSpeechMs: callDataRef.current.totalAgentSpeechMs,
      });
    },
    [sessionId, updateVoiceCall]
  );

  return {
    startCall,
    endCall,
    trackInterruption,
    trackUserSpeech,
    trackAgentSpeech,
  };
}
