import { useCallback, useEffect, useRef, useState } from 'react';
import { useKeyboard, useTerminalDimensions } from '@opentui/react';
import type { Block, LoggedEvent, Session, TurnStatus } from '@kuralle-agents/client';
import { BlockView } from './BlockView.js';
import { blocksFromEvents, nextUserId } from './transcript.js';

export interface ChatAppProps {
  session: Session;
  title?: string;
  scripted?: string[];
  terminalWidth?: number;
  terminalHeight?: number;
  bindCancelHandler?: (handler: () => void) => void;
}

function statusLine(status: TurnStatus, sessionId: string, busy: boolean): string {
  const state = busy ? 'streaming' : status;
  return `session ${sessionId.slice(0, 8)} · ${state}`;
}

function SideRegion() {
  return (
    <box
      title="Trace"
      style={{
        width: 40,
        border: true,
        flexDirection: 'column',
        padding: 1,
      }}
    >
      <text style={{ fg: '#565f89' }} content="trace rail · t14" />
    </box>
  );
}

function ChatLayout({
  width,
  height,
  title,
  blocks,
  status,
  busy,
  input,
  onInput,
  onSubmit,
}: {
  width: number;
  height: number;
  title: string;
  blocks: Block[];
  status: string;
  busy: boolean;
  input: string;
  onInput: (value: string) => void;
  onSubmit: (value: string) => void;
}) {
  const showSide = width >= 90;
  const mainWidth = showSide ? width - 42 : width;

  return (
    <box style={{ width, height, flexDirection: 'column' }}>
      <box style={{ border: true, paddingX: 1 }}>
        <text style={{ fg: '#7aa2f7' }} content={title} />
      </box>
      <box style={{ flexGrow: 1, flexDirection: 'row' }}>
        <box style={{ width: mainWidth, flexDirection: 'column', flexGrow: 1 }}>
          <scrollbox style={{ flexGrow: 1 }} focused={false}>
            {blocks.map((block) => (
              <BlockView key={block.id} block={block} />
            ))}
          </scrollbox>
          <box style={{ border: true, paddingX: 1 }}>
            <text content={status} />
          </box>
          {!busy && (
            <box style={{ border: true, height: 3 }}>
              <input
                focused
                placeholder="Message…"
                value={input}
                onInput={onInput}
                onSubmit={(value) => {
                  if (typeof value === 'string') onSubmit(value);
                }}
              />
            </box>
          )}
        </box>
        {showSide ? <SideRegion /> : null}
      </box>
    </box>
  );
}

function ChatAppInner({
  session,
  title = 'Kuralle',
  scripted,
  bindCancelHandler,
  width,
  height,
}: ChatAppProps & { width: number; height: number }) {
  const [blocks, setBlocks] = useState<Block[]>([]);
  const [status, setStatus] = useState<TurnStatus>('idle');
  const [busy, setBusy] = useState(false);
  const [input, setInput] = useState('');
  const eventsRef = useRef<LoggedEvent[]>([]);
  const sessionUsersRef = useRef<Block[]>([]);
  const userSeqRef = useRef(0);
  const scriptedIndexRef = useRef(0);
  const busyRef = useRef(false);
  const turnAbortRef = useRef(false);

  const refresh = useCallback(() => {
    setBlocks(blocksFromEvents(eventsRef.current, sessionUsersRef.current));
  }, []);

  useEffect(() => {
    busyRef.current = busy;
  }, [busy]);

  useEffect(() => {
    let cancelled = false;
    void session.snapshot().then((snap) => {
      if (cancelled) return;
      eventsRef.current = snap.events;
      refresh();
    });
    return () => {
      cancelled = true;
    };
  }, [session, refresh]);

  const submit = useCallback(
    async (raw: string) => {
      const text = raw.trim();
      if (!text || busyRef.current) return;
      setInput('');
      sessionUsersRef.current = [
        ...sessionUsersRef.current,
        { id: nextUserId(userSeqRef.current++), kind: 'user', text },
      ];
      refresh();
      setBusy(true);
      setStatus('streaming');

      const turn = await session.send(text);
      try {
        turnAbortRef.current = false;
        for await (const event of turn) {
          if (turnAbortRef.current) break;
          eventsRef.current = [...eventsRef.current, event];
          if (event.part.type === 'done') setStatus('completed');
          refresh();
        }
        if (!turnAbortRef.current) {
          await turn.result();
        }
      } finally {
        turnAbortRef.current = false;
        setBusy(false);
        refresh();
      }
    },
    [refresh, session],
  );

  const scriptedStartedRef = useRef(false);

  const cancelActiveTurn = useCallback(() => {
    if (!busyRef.current) return;
    turnAbortRef.current = true;
    void session.cancel('user stopped');
    setBusy(false);
    setStatus('waiting');
    refresh();
  }, [refresh, session]);

  useEffect(() => {
    bindCancelHandler?.(cancelActiveTurn);
  }, [bindCancelHandler, cancelActiveTurn]);

  useKeyboard((key) => {
    if (key.name === 'escape') cancelActiveTurn();
  });

  useEffect(() => {
    if (!scripted?.length || scriptedStartedRef.current) return;
    scriptedStartedRef.current = true;
    let cancelled = false;
    const run = async () => {
      while (!cancelled && scriptedIndexRef.current < scripted.length) {
        const line = scripted[scriptedIndexRef.current++]!;
        await submit(line);
      }
    };
    void run();
    return () => {
      cancelled = true;
    };
  }, [scripted, submit]);

  return (
    <ChatLayout
      width={width}
      height={height}
      title={title}
      blocks={blocks}
      status={statusLine(status, session.id, busy)}
      busy={busy || Boolean(scripted?.length && scriptedIndexRef.current < scripted.length)}
      input={input}
      onInput={setInput}
      onSubmit={(value) => {
        void submit(value);
      }}
    />
  );
}

function ChatAppSized(props: ChatAppProps) {
  const { width, height } = useTerminalDimensions();
  return <ChatAppInner {...props} width={width} height={height} />;
}

export function ChatApp(props: ChatAppProps) {
  if (props.terminalWidth !== undefined && props.terminalHeight !== undefined) {
    return (
      <ChatAppInner
        {...props}
        width={props.terminalWidth}
        height={props.terminalHeight}
      />
    );
  }
  return <ChatAppSized {...props} />;
}
