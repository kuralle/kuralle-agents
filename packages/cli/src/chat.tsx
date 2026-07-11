/**
 * Kuralle TUI chat — interactive terminal REPL for a live Kuralle runtime.
 *
 * Slash commands: /state  /reset  /help  /quit
 */
import React, { useEffect, useRef, useState } from 'react';
import { render, Box, Text, useApp, useInput, Static } from 'ink';
import TextInput from 'ink-text-input';
import type { HarnessStreamPart } from '@kuralle-agents/core';
import type { AgentRuntime, BuildRuntime } from './agentRuntime.js';
import { newSessionId } from './sessionId.js';

type Line = { id: number; kind: 'user' | 'assistant' | 'event' | 'system'; text: string };
let LINE_ID = 0;
const line = (kind: Line['kind'], text: string): Line => ({ id: LINE_ID++, kind, text });

async function runTurn(
  demo: AgentRuntime,
  input: string,
  onText: (t: string) => void,
  onEvent: (e: string) => void,
): Promise<string> {
  const handle = demo.runtime.run({ sessionId: demo.sessionId, input });
  let text = '';
  try {
    for await (const part of handle.events as AsyncIterable<HarnessStreamPart>) {
      if (part.type === 'text-delta') { text += part.delta; onText(text); }
      else if (part.type === 'tool-call') onEvent(`⚙ tool ${part.toolName}`);
      else if (part.type === 'flow-enter') onEvent(`▸ enter flow ${part.flow}`);
      else if (part.type === 'flow-end') onEvent(`■ end flow ${part.flow}`);
      else if (part.type === 'handoff') onEvent(`→ handoff ${part.targetAgent}`);
      else if (part.type === 'paused') onEvent(`⏸ paused ${(part as { waitingFor?: string }).waitingFor ?? ''}`);
      else if (part.type === 'error') onEvent(`✖ ${(part as { error?: unknown }).error}`);
    }
    const res = await handle;
    if (!text && typeof (res as { text?: string }).text === 'string') text = (res as { text: string }).text;
  } catch (e) {
    onEvent(`✖ ${e instanceof Error ? e.message : String(e)}`);
  }
  return text.trim();
}

function App({ scripted, buildRuntime }: { scripted?: string[]; buildRuntime: BuildRuntime }) {
  const { exit } = useApp();
  const demoRef = useRef<AgentRuntime>(buildRuntime());
  const [log, setLog] = useState<Line[]>([line('system', demoRef.current.label)]);
  const [live, setLive] = useState('');
  const [events, setEvents] = useState<string[]>([]);
  const [status, setStatus] = useState('flow: none · epoch: 0');
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);

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
      demoRef.current = buildRuntime(newSessionId());
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
    const answer = await runTurn(demoRef.current, text, setLive, (e) => { turnEvents.push(e); setEvents([...turnEvents]); });
    setLive('');
    for (const e of turnEvents) push(line('event', e));
    push(line('assistant', answer || '(no text)'));
    setBusy(false);
    await refreshStatus();
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

  return (
    <Box flexDirection="column">
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
}

export function runChat(argv: string[], buildRuntime: BuildRuntime): void {
  const autoIdx = argv.indexOf('--auto');
  const scripted = autoIdx >= 0 ? (argv[autoIdx + 1] ?? '').split('|').map((s) => s.trim()).filter(Boolean) : undefined;
  render(<App scripted={scripted} buildRuntime={buildRuntime} />);
}