import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useTerminalDimensions } from '@opentui/react';
import {
  createClient,
  readHostedConnection,
  type Client,
  type HostedConnection,
  type Session,
  type Target,
} from '@kuralle-agents/client';
import { ChatApp } from './ChatApp.js';
import type { RailTab } from './RailPanel.js';
import { ConnectScreen } from './ConnectScreen.js';
import {
  connectSavedConnection,
  defaultSlashHandlers,
  executeSlashCommand,
  type SlashContext,
  type SlashHandlers,
} from './slashCommands.js';
import { readRecentTargets } from './recentTargets.js';

export interface KuralleTuiProps {
  initialTarget?: Target;
  initialConnection?: HostedConnection;
  initialSession?: Session;
  initialClient?: Client;
  initialTitle?: string;
  autoConnectSaved?: boolean;
  scriptedSlash?: string[];
  terminalWidth?: number;
  terminalHeight?: number;
  userId?: string;
  handlers?: Partial<SlashHandlers>;
  createClientFn?: typeof createClient;
  onQuit?: () => void;
  exposeSlash?: (run: (command: string) => Promise<boolean>) => void;
}

function mergeHandlers(overrides?: Partial<SlashHandlers>): SlashHandlers {
  return { ...defaultSlashHandlers, ...overrides, createClient: overrides?.createClient ?? defaultSlashHandlers.createClient };
}

function KuralleTuiInner({
  initialTarget,
  initialConnection,
  initialSession,
  initialClient,
  initialTitle,
  width,
  height,
  userId: initialUserId,
  handlers: handlerOverrides,
  createClientFn = createClient,
  onQuit,
  scriptedSlash,
  autoConnectSaved,
  exposeSlash,
}: KuralleTuiProps & { width: number; height: number }) {
  const handlers = mergeHandlers({ ...handlerOverrides, createClient: createClientFn });
  const [view, setView] = useState<'connect' | 'chat'>(initialSession ? 'chat' : 'connect');
  const [client, setClient] = useState<Client | null>(initialClient ?? null);
  const [session, setSession] = useState<Session | null>(initialSession ?? null);
  const [target, setTarget] = useState<Target | null>(initialTarget ?? null);
  const [connection, setConnection] = useState<HostedConnection | null>(initialConnection ?? null);
  const [title, setTitle] = useState(initialTitle ?? 'Kuralle');
  const [userId, setUserId] = useState(initialUserId);
  const [saved, setSaved] = useState<HostedConnection | undefined>();
  const [recent, setRecent] = useState<string[]>([]);
  const [message, setMessage] = useState<string | undefined>();
  const [railTab, setRailTab] = useState<RailTab | undefined>();
  const [sessionEpoch, setSessionEpoch] = useState(0);
  const cancelTurnRef = useRef<(() => void) | null>(null);
  const sessionRef = useRef<Session | null>(initialSession ?? null);
  const contextRef = useRef<SlashContext>({
    client: initialClient ?? null,
    session: initialSession ?? null,
    target: initialTarget ?? null,
    connection: initialConnection ?? null,
    userId: initialUserId,
    title: initialTitle ?? 'Kuralle',
  });

  useEffect(() => {
    sessionRef.current = session;
  }, [session]);

  useEffect(() => {
    contextRef.current = {
      client,
      session,
      target,
      connection,
      userId,
      title,
    };
  }, [client, connection, session, target, title, userId]);

  const refreshConnectData = useCallback(async () => {
    setSaved(await handlers.readHostedConnection());
    setRecent(await handlers.readRecentTargets());
  }, [handlers]);

  useEffect(() => {
    void refreshConnectData();
  }, [refreshConnectData]);

  const applyContext = useCallback(async (next: Partial<SlashContext>) => {
    const previous = sessionRef.current;
    if (previous && (next.session !== previous || next.client !== client || next.resetSession)) {
      cancelTurnRef.current?.();
      await previous.cancel('target swap');
    }

    if (next.client !== undefined) {
      setClient(next.client);
      contextRef.current.client = next.client;
    }
    if (next.session !== undefined) {
      setSession(next.session);
      contextRef.current.session = next.session;
    }
    if (next.target !== undefined) {
      setTarget(next.target);
      contextRef.current.target = next.target;
    }
    if (next.connection !== undefined) {
      setConnection(next.connection);
      contextRef.current.connection = next.connection;
    }
    if (next.title !== undefined) {
      setTitle(next.title);
      contextRef.current.title = next.title;
    }
    if (next.userId !== undefined) {
      setUserId(next.userId);
      contextRef.current.userId = next.userId;
    }
    if (next.railTab) setRailTab(next.railTab);
    if (next.resetSession) setSessionEpoch((value) => value + 1);

    if (next.session) setView('chat');
    if (next.client === null && next.session === null) {
      setView('connect');
      await refreshConnectData();
    }
  }, [client, refreshConnectData]);

  const slashContext = (): SlashContext => contextRef.current;

  const handleSlash = useCallback(async (line: string) => {
    try {
      const { outcome, next } = await executeSlashCommand(line, slashContext(), handlers);
      if (outcome.quit) {
        onQuit?.();
        return true;
      }
      if (outcome.message) setMessage(outcome.message);
      if (Object.keys(next).length > 0) await applyContext(next);
      return outcome.handled;
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error);
      setMessage(text);
      return true;
    }
  }, [applyContext, handlers, onQuit, client, session, target, connection, userId, title]);

  const handleConnectSaved = useCallback(async () => {
    const connected = await connectSavedConnection(handlers);
    if (!connected) {
      setMessage('No saved connection.');
      return;
    }
    await applyContext({
      client: connected.client,
      session: connected.session,
      target: connected.target,
      connection: connected.connection,
      title: connected.label,
      resetSession: true,
    });
  }, [applyContext, handlers]);

  const interceptSubmit = useCallback(async (text: string) => {
    if (!text.startsWith('/')) return false;
    return handleSlash(text);
  }, [handleSlash]);

  useLayoutEffect(() => {
    exposeSlash?.(handleSlash);
  }, [exposeSlash, handleSlash]);

  useEffect(() => {
    if (!autoConnectSaved || view !== 'connect') return;
    void handleConnectSaved();
  }, [autoConnectSaved, handleConnectSaved, view]);

  if (view === 'connect' || !session) {
    return (
      <ConnectScreen
        width={width}
        height={height}
        saved={saved}
        recent={recent}
        message={message}
        onSubmit={async (line) => {
          if (line.startsWith('/')) {
            await handleSlash(line);
            return;
          }
          setMessage(`Unknown input: ${line}`);
        }}
        onConnectSaved={handleConnectSaved}
      />
    );
  }

  return (
    <ChatApp
      key={`${session.id}:${sessionEpoch}`}
      session={session}
      title={title}
      terminalWidth={width}
      terminalHeight={height}
      userId={userId}
      bindCancelHandler={(handler) => {
        cancelTurnRef.current = handler;
      }}
      onInterceptSubmit={interceptSubmit}
      focusRailTab={railTab}
      commandNotice={message}
      scriptedSlash={scriptedSlash}
    />
  );
}

export function KuralleTui(props: KuralleTuiProps) {
  if (props.terminalWidth !== undefined && props.terminalHeight !== undefined) {
    return (
      <KuralleTuiInner
        {...props}
        width={props.terminalWidth}
        height={props.terminalHeight}
      />
    );
  }
  const { width, height } = useTerminalDimensions();
  return <KuralleTuiInner {...props} width={width} height={height} />;
}
