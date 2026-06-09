#!/usr/bin/env bun
/**
 * Live chat harness for the deployed Pharmacy Rx agent (CF Agents WS protocol).
 *
 * Usage:
 *   bun run tools/live-chat.ts <thread> "<text>" [imageUrl]
 *   HOST=wss://pharmacy-rx-agent.<sub>.workers.dev bun run tools/live-chat.ts t1 "hi"
 *
 * Drives one turn over the `cf_agent_use_chat_request` frame, prints streamed
 * response + the final persisted message list (proves the reply + persistence).
 */
const HOST = process.env.HOST ?? 'wss://pharmacy-rx-agent.mithushancj.workers.dev';
const thread = process.argv[2] ?? 'demo-thread';
const text = process.argv[3] ?? 'Hello';
const imageUrl = process.argv[4];

const uid = () => crypto.randomUUID();

const parts: Array<Record<string, unknown>> = [{ type: 'text', text }];
if (imageUrl) parts.push({ type: 'file', url: imageUrl, mediaType: 'image/jpeg', filename: 'rx.jpg' });

const userMessage = { id: uid(), role: 'user', parts };
const requestId = uid();

const url = `${HOST}/agents/pharmacy-agent/${thread}`;
console.log(`→ connecting ${url}`);
const ws = new WebSocket(url);

let lastMessages: unknown[] | null = null;
let streamed = '';

ws.addEventListener('open', () => {
  console.log('→ sending chat request:', JSON.stringify({ text, imageUrl }));
  ws.send(
    JSON.stringify({
      type: 'cf_agent_use_chat_request',
      id: requestId,
      init: {
        method: 'POST',
        body: JSON.stringify({ id: requestId, messages: [userMessage], trigger: 'submit-message' }),
      },
    }),
  );
});

ws.addEventListener('message', (ev: MessageEvent) => {
  let frame: Record<string, unknown>;
  try {
    frame = JSON.parse(String(ev.data));
  } catch {
    return;
  }
  if (frame.type === 'cf_agent_use_chat_response') {
    if (typeof frame.body === 'string' && frame.body) streamed += frame.body;
    if (frame.done) {
      console.log('\n--- raw streamed response body ---\n' + streamed.slice(0, 4000));
    }
  } else if (frame.type === 'cf_agent_chat_messages') {
    lastMessages = (frame.messages as unknown[]) ?? null;
  }
});

ws.addEventListener('error', (e) => console.error('ws error', e));

// Give the model time to read the image + run tools, then report and exit.
setTimeout(() => {
  console.log('\n=== final persisted messages ===');
  if (lastMessages) {
    for (const m of lastMessages as Array<{ role: string; parts?: Array<{ type: string; text?: string }> }>) {
      const t = (m.parts ?? []).filter((p) => p.type === 'text').map((p) => p.text).join(' ');
      console.log(`[${m.role}] ${t.slice(0, 500)}`);
    }
    console.log(`(count: ${(lastMessages as unknown[]).length})`);
  } else {
    console.log('(no cf_agent_chat_messages broadcast received)');
  }
  ws.close();
  process.exit(0);
}, Number(process.env.WAIT_MS ?? 45000));
