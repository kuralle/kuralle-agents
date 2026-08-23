import { useCallback, useEffect, useRef, useState } from 'react';
import { useKeyboard, useTerminalDimensions } from '@opentui/react';
import { reduce, type Block, type LoggedEvent, type Session, type TurnStatus } from '@kuralle-agents/client';
import { ApprovalPanel } from './ApprovalPanel.js';
import { buildApprovalResponse, type PendingInterrupt } from './approvalRespond.js';
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

function statusLine(
  status: TurnStatus,
  sessionId: string,
  busy: boolean,
  approvalPending: PendingInterrupt | null,
): string {
  if (approvalPending) {
    const tool = approvalPending.operation?.toolName ?? approvalPending.display.title;
    return `session ${sessionId.slice(0, 8)} · approval required for ${tool} — input disabled`;
  }
  const state = busy ? 'streaming' : status;
  return `session ${sessionId.slice(0, 8)} · ${state}`;
}

function pendingApprovalFromEvents(events: LoggedEvent[]): PendingInterrupt | null {
  const view = reduce(events);
  if (view.status !== 'input-required') return null;
  const interrupt = view.pending[0];
  if (!interrupt || interrupt.kind !== 'approval') return null;
  return interrupt;
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
  approvalPending,
  inspectingArgs,
  input,
  onInput,
  onSubmit,
  onApprovalDecision,
  onInspectArgs,
}: {
  width: number;
  height: number;
  title: string;
  blocks: Block[];
  status: string;
  busy: boolean;
  approvalPending: PendingInterrupt | null;
  inspectingArgs: boolean;
  input: string;
  onInput: (value: string) => void;
  onSubmit: (value: string) => void;
  onApprovalDecision: (decision: 'approve' | 'deny') => void;
  onInspectArgs: () => void;
}) {
  const showSide = width >= 90;
  const mainWidth = showSide ? width - 42 : width;
  const composerDisabled = busy || approvalPending !== null;

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
          {approvalPending ? (
            <ApprovalPanel
              interrupt={approvalPending}
              inspecting={inspectingArgs}
              onDecision={onApprovalDecision}
              onInspect={onInspectArgs}
            />
          ) : null}
          <box style={{ border: true, paddingX: 1 }}>
            <text content={status} />
          </box>
          {!composerDisabled && (
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
  const [approvalPending, setApprovalPending] = useState<PendingInterrupt | null>(null);
  const [inspectingArgs, setInspectingArgs] = useState(false);
  const [input, setInput] = useState('');
  const eventsRef = useRef<LoggedEvent[]>([]);
  const sessionUsersRef = useRef<Block[]>([]);
  const userSeqRef = useRef(0);
  const scriptedIndexRef = useRef(0);
  const busyRef = useRef(false);
  const turnAbortRef = useRef(false);
  const approvalPendingRef = useRef<PendingInterrupt | null>(null);

  const refresh = useCallback(() => {
    setBlocks(blocksFromEvents(eventsRef.current, sessionUsersRef.current));
    const pending = pendingApprovalFromEvents(eventsRef.current);
    setApprovalPending(pending);
    approvalPendingRef.current = pending;
    if (pending) {
      setStatus('input-required');
    }
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

  const drainTurn = useCallback(
    async (turn: AsyncIterable<LoggedEvent> & { result(): Promise<unknown> }) => {
      try {
        turnAbortRef.current = false;
        for await (const event of turn) {
          if (turnAbortRef.current) break;
          eventsRef.current = [...eventsRef.current, event];
          if (event.part.type === 'done') setStatus('completed');
          if (event.part.type === 'paused') setStatus('input-required');
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
    [refresh],
  );

  const submit = useCallback(
    async (raw: string) => {
      const text = raw.trim();
      if (!text || busyRef.current || approvalPendingRef.current) return;
      setInput('');
      sessionUsersRef.current = [
        ...sessionUsersRef.current,
        { id: nextUserId(userSeqRef.current++), kind: 'user', text },
      ];
      refresh();
      setBusy(true);
      setStatus('streaming');
      setInspectingArgs(false);

      const turn = await session.send(text);
      await drainTurn(turn);
    },
    [drainTurn, refresh, session],
  );

  const respondToApproval = useCallback(
    async (decision: 'approve' | 'deny') => {
      const pending = approvalPendingRef.current;
      if (!pending || busyRef.current) return;
      setInspectingArgs(false);
      setBusy(true);
      setStatus('streaming');

      const turn = await session.respond(buildApprovalResponse(pending, decision));
      await drainTurn(turn);
    },
    [drainTurn, session],
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
      status={statusLine(status, session.id, busy, approvalPending)}
      busy={busy || Boolean(scripted?.length && scriptedIndexRef.current < scripted.length)}
      approvalPending={approvalPending}
      inspectingArgs={inspectingArgs}
      input={input}
      onInput={setInput}
      onSubmit={(value) => {
        void submit(value);
      }}
      onApprovalDecision={(decision) => {
        void respondToApproval(decision);
      }}
      onInspectArgs={() => {
        setInspectingArgs(true);
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
