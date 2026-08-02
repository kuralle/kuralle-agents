/**
 * Kuralle TUI chat — interactive terminal REPL for a live Kuralle runtime.
 *
 * Slash commands: /state  /reset  /help  /quit
 */
import React, { useEffect, useRef, useState } from 'react';
import { render, Box, Text, useApp, useInput, Static } from 'ink';
import TextInput from 'ink-text-input';
import type { AgentSpan, AgentTrace, StreamPart, SessionStore, TraceStore } from '@kuralle-agents/core';
import type { AgentRuntime, BuildRuntime } from './agentRuntime.js';
import { newSessionId } from './sessionId.js';
import { fileSessionStore } from './fileStore.js';
import { fileTraceStore } from './fileTraceStore.js';

type Persist = { sessionStore: SessionStore; traceStore: TraceStore; sessionId: string };

/** Order spans as a depth-first tree (turn root → flow → node → tool/handoff). */
function orderSpans(spans: AgentSpan[]): Array<{ span: AgentSpan; depth: number }> {
  const byParent = new Map<string | undefined, AgentSpan[]>();
  for (const s of spans) {
    const list = byParent.get(s.parentSpanId) ?? [];
    list.push(s);
    byParent.set(s.parentSpanId, list);
  }
  const roots = spans.filter((s) => !s.parentSpanId || !spans.some((p) => p.spanId === s.parentSpanId));
  const out: Array<{ span: AgentSpan; depth: number }> = [];
  const walk = (s: AgentSpan, depth: number): void => {
    out.push({ span: s, depth });
    for (const child of byParent.get(s.spanId) ?? []) walk(child, depth + 1);
  };
  for (const r of roots) walk(r, 0);
  return out;
}

const kindColor = (k: AgentSpan['kind']): string =>
  k === 'turn' ? 'white' : k === 'flow' ? 'magenta' : k === 'node' ? 'blue' : k === 'tool' ? 'yellow' : k === 'handoff' ? 'cyan' : 'gray';

/** Live trace side panel — the built-in AgentTrace of the last turn. */
function TracePanel({ trace }: { trace: AgentTrace | null }): React.ReactElement {
  const turn = trace?.spans.find((s) => s.kind === 'turn');
  const tin = turn?.attributes.tokensIn;
  const tout = turn?.attributes.tokensOut;
  const ctx = turn?.attributes.contextTokens;
  const ttft = turn?.attributes.ttftMs;
  const parts: string[] = [];
  if (tin !== undefined || tout !== undefined) parts.push(`turn ${tin ?? '?'}↓/${tout ?? '?'}↑ tok`);
  if (ctx !== undefined) parts.push(`ctx ${ctx} tok`);
  if (ttft !== undefined) parts.push(`TTFT ${ttft}ms`);
  const tokensLine = parts.length > 0 ? parts.join(' · ') : undefined;
  return (
    <Box flexDirection="column" width={46} borderStyle="round" borderColor="gray" paddingX={1}>
      <Text bold color="gray">TRACE {trace ? `· ${trace.traceId.slice(0, 8)}` : ''}</Text>
      {!trace && <Text dimColor>run a turn to see its trace…</Text>}
      {trace && (
        <>
          {orderSpans(trace.spans).map(({ span, depth }) => (
            <Text key={span.spanId} color={kindColor(span.kind)}>
              {'  '.repeat(depth)}{span.status === 'error' ? '✖ ' : ''}{span.name}
              <Text dimColor> · {span.endTime ? `${span.endTime - span.startTime}ms` : '…'}</Text>
            </Text>
          ))}
          <Box marginTop={1} flexDirection="column">
            {tokensLine && <Text color="cyan">{tokensLine}</Text>}
            <Text dimColor>used tool: {String(trace.usedTool)}</Text>
            {trace.toolResults.map((r, i) => (
              <Text key={i} color="yellow" wrap="truncate-end">→ {r.name}: {JSON.stringify(r.result)}</Text>
            ))}
          </Box>
        </>
      )}
    </Box>
  );
}

type Line = { id: number; kind: 'user' | 'assistant' | 'event' | 'system'; text: string };
let LINE_ID = 0;
const line = (kind: Line['kind'], text: string): Line => ({ id: LINE_ID++, kind, text });

async function runTurn(
  demo: AgentRuntime,
  input: string,
  onText: (t: string) => void,
  onEvent: (e: string) => void,
): Promise<{ answer: string; ttftMs: number | null; totalMs: number }> {
  const started = performance.now();
  const handle = demo.runtime.run({ sessionId: demo.sessionId, input });
  let ttftMs: number | null = null;
  let text = '';
  try {
    for await (const part of handle.events as AsyncIterable<StreamPart>) {
      if (part.type === 'text-delta') {
        if (part.payload.delta && ttftMs === null) ttftMs = performance.now() - started;
        text += part.payload.delta;
        onText(text);
      }
      else if (part.type === 'tool-call') onEvent(`⚙ tool ${part.payload.toolName}`);
      else if (part.type === 'flow-enter') onEvent(`▸ enter flow ${part.payload.flow}`);
      else if (part.type === 'flow-end') onEvent(`■ end flow ${part.payload.flow}`);
      else if (part.type === 'handoff') onEvent(`→ handoff ${part.payload.targetAgent}`);
      else if (part.type === 'paused') onEvent(`⏸ paused ${part.payload.waitingFor}`);
      else if (part.type === 'error') onEvent(`✖ ${part.payload.error}`);
    }
    const res = await handle;
    if (!text && typeof (res as { text?: string }).text === 'string') text = (res as { text: string }).text;
  } catch (e) {
    onEvent(`✖ ${e instanceof Error ? e.message : String(e)}`);
  }
  return { answer: text.trim(), ttftMs, totalMs: performance.now() - started };
}

function App({ scripted, runtime, buildRuntime, showTrace, persist }: { scripted?: string[]; runtime: AgentRuntime; buildRuntime: BuildRuntime; showTrace?: boolean; persist?: Persist }) {
  const { exit } = useApp();
  const make = (sid?: string): AgentRuntime | Promise<AgentRuntime> =>
    persist ? buildRuntime(sid ?? persist.sessionId, persist.sessionStore, persist.traceStore) : buildRuntime(sid);
  const demoRef = useRef<AgentRuntime>(runtime);
  const [log, setLog] = useState<Line[]>([line('system', demoRef.current.label)]);
  const [live, setLive] = useState('');
  const [events, setEvents] = useState<string[]>([]);
  const [status, setStatus] = useState('flow: none · epoch: 0');
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  const [trace, setTrace] = useState<AgentTrace | null>(null);

  useInput((input, key) => { if (key.ctrl && input === 'c') exit(); }, { isActive: !scripted && Boolean(process.stdin.isTTY) });

  const push = (l: Line) => setLog((prev) => [...prev, l]);
  const refreshStatus = async () => {
    const s = await demoRef.current.readState();
    setStatus(`flow: ${s.activeFlow ?? 'none'} · epoch: ${s.runEpoch ?? 0} · done: ${JSON.stringify(s.completedFlows ?? [])}`);
  };

  const submit = async (raw: string) => {
    const text = raw.trim();
    if (!text || busy) return;
    setValue('');
    if (text === '/quit') { exit(); return; }
    if (text === '/help') { push(line('system', 'commands: /state  /reset  /quit')); return; }
    if (text === '/reset') {
      demoRef.current = await make(newSessionId());
      push(line('system', `— new session ${demoRef.current.sessionId.slice(0, 8)} —`));
      await refreshStatus();
      return;
    }
    if (text === '/state') {
      const s = await demoRef.current.readState();
      push(line('system', `state: flow=${s.activeFlow ?? 'none'} epoch=${s.runEpoch ?? 0} completed=${JSON.stringify(s.completedFlows ?? [])} roles=[${s.roles.join(',')}]`));
      return;
    }

    push(line('user', text));
    setBusy(true); setEvents([]); setLive('');
    const turnEvents: string[] = [];
    const timing = await runTurn(demoRef.current, text, setLive, (e) => { turnEvents.push(e); setEvents([...turnEvents]); });
    setLive('');
    for (const e of turnEvents) push(line('event', e));
    push(line('assistant', timing.answer || '(no text)'));
    push(line(
      'system',
      `TTFT ${timing.ttftMs === null ? 'none' : `${Math.round(timing.ttftMs)}ms`} · total ${Math.round(timing.totalMs)}ms`,
    ));
    setBusy(false);
    await refreshStatus();
    if (showTrace) {
      setTrace((await demoRef.current.runtime.listTraces(demoRef.current.sessionId))[0] ?? null);
    }
  };

  useEffect(() => {
    if (!scripted?.length) return;
    let cancelled = false;
    (async () => {
      for (const t of scripted) { if (cancelled) return; await submit(t); }
      push(line('system', '— auto complete —'));
      setTimeout(() => exit(), 100);
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const color = (k: Line['kind']) => (k === 'user' ? 'cyan' : k === 'assistant' ? 'green' : k === 'event' ? 'gray' : 'yellow');
  const prefix = (k: Line['kind']) => (k === 'user' ? 'You' : k === 'assistant' ? 'Agent' : k === 'event' ? '  ·' : '  ~');

  const body = (
    <Box flexDirection="column" flexGrow={1} paddingRight={showTrace ? 1 : 0}>
      <Static items={log}>
        {(l) => (
          <Text key={l.id} color={color(l.kind)}>
            <Text bold={l.kind === 'user' || l.kind === 'assistant'}>{prefix(l.kind)}</Text>
            {'  '}{l.text}
          </Text>
        )}
      </Static>
      {busy && (
        <Box flexDirection="column">
          {events.length > 0 && <Text color="gray">{events.join('  ')}</Text>}
          <Text color="green"><Text bold>Agent</Text>  {live}<Text color="green">▌</Text></Text>
        </Box>
      )}
      <Box marginTop={1}>
        <Text dimColor>{status}</Text>
      </Box>
      {!scripted && (
        <Box>
          <Text color="cyan">{busy ? '…thinking  ' : '❯ '}</Text>
          {!busy && <TextInput value={value} onChange={setValue} onSubmit={submit} placeholder="type a message, or /help" />}
        </Box>
      )}
    </Box>
  );
  return showTrace ? (
    <Box flexDirection="row">{body}<TracePanel trace={trace} /></Box>
  ) : body;
}

export async function runChat(argv: string[], buildRuntime: BuildRuntime): Promise<void> {
  const flag = (name: string): string | undefined => {
    const i = argv.indexOf(name);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const scripted = argv.includes('--auto')
    ? (flag('--auto') ?? '').split('|').map((s) => s.trim()).filter(Boolean)
    : undefined;
  const showTrace = argv.includes('--trace');

  // --store persists BOTH the session (conversation/journal) and the traces to
  // JSON files, so `--trace` accumulates across launches. --session picks the id.
  const storePath = flag('--store');
  const persist: Persist | undefined = storePath
    ? {
        sessionStore: fileSessionStore(storePath),
        traceStore: fileTraceStore(storePath.replace(/\.json$/, '') + '.traces.json'),
        sessionId: flag('--session') ?? 'default',
      }
    : undefined;

  // Resolved BEFORE render() — a React function component cannot await, so an async
  // factory (e.g. one that loads remote config) must finish here, not during render.
  const runtime = await (persist
    ? buildRuntime(persist.sessionId, persist.sessionStore, persist.traceStore)
    : buildRuntime());

  render(<App scripted={scripted} runtime={runtime} buildRuntime={buildRuntime} showTrace={showTrace} persist={persist} />);
}
