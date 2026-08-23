import { useState } from 'react';
import { useKeyboard } from '@opentui/react';
import type { HostedConnection } from '@kuralle-agents/client';

const HELP = [
  '/connect <url> [--agent-name x] [--transport http|cloudflare] [--token-env VAR]',
  '/agent <path.ts> [--model id]',
  '/session <id>   attach to an existing session',
  '/user <id>      memory owner for new sessions',
  '/disconnect     drop the active target',
  '/connection     show active and saved connection',
  '/save           persist active target as default',
  '/memory · /trace · /reset · /help · /quit',
].join('\n');

export interface ConnectScreenProps {
  width: number;
  height: number;
  saved?: HostedConnection;
  recent: string[];
  message?: string;
  onSubmit: (line: string) => void | Promise<void>;
  onConnectSaved: () => void | Promise<void>;
}

export function ConnectScreen({
  width,
  height,
  saved,
  recent,
  message,
  onSubmit,
  onConnectSaved,
}: ConnectScreenProps) {
  const [input, setInput] = useState('');

  useKeyboard((key) => {
    if (key.name === 'escape') setInput('');
    if (key.name === 'return' && !input.trim()) void onConnectSaved();
  });

  return (
    <box style={{ width, height, flexDirection: 'column' }}>
      <box style={{ border: true, paddingX: 1 }}>
        <text style={{ fg: '#7aa2f7' }} content="Kuralle · Connect" />
      </box>
      <scrollbox style={{ flexGrow: 1, paddingX: 1 }} focused={false}>
        <text content="No session target. Connect with Enter (saved) or a slash command." />
        <text content="" />
        {saved ? (
          <>
            <text style={{ fg: '#9ece6a' }} content="Saved (Enter to use):" />
            <text content={`  ${saved.server}`} />
            {saved.transport ? <text content={`  transport: ${saved.transport}`} /> : null}
            {saved.agentName ? <text content={`  agent: ${saved.agentName}`} /> : null}
          </>
        ) : (
          <text content="No saved connection — use /connect or /agent." />
        )}
        {recent.length > 0 ? (
          <>
            <text content="" />
            <text style={{ fg: '#bb9af7' }} content="Recent:" />
            {recent.map((entry) => (
              <text key={entry} content={`  ${entry}`} />
            ))}
          </>
        ) : null}
        {message ? (
          <>
            <text content="" />
            <text style={{ fg: '#e0af68' }} content={message} />
          </>
        ) : null}
      </scrollbox>
      <box style={{ border: true, paddingX: 1 }}>
        <text content="Enter = saved · /help for commands" />
      </box>
      <box style={{ border: true, height: 3 }}>
        <input
          focused
          placeholder="Command…"
          value={input}
          onInput={setInput}
          onSubmit={(value) => {
            const line = typeof value === 'string' ? value.trim() : '';
            setInput('');
            if (!line) {
              void onConnectSaved();
              return;
            }
            void onSubmit(line);
          }}
        />
      </box>
    </box>
  );
}

export function formatConnectionInfo(
  active: { label: string; sessionId?: string } | undefined,
  saved: HostedConnection | undefined,
): string {
  const lines: string[] = [];
  if (active) {
    lines.push(`Active: ${active.label}${active.sessionId ? ` · session ${active.sessionId.slice(0, 8)}` : ''}`);
  } else {
    lines.push('Active: (none)');
  }
  if (saved) {
    lines.push(`Saved: ${saved.server}${saved.agentName ? ` · ${saved.agentName}` : ''}`);
  } else {
    lines.push('Saved: (none)');
  }
  return lines.join('\n');
}

export { HELP as CONNECT_HELP };
