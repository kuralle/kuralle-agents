import { WebSocketServer, Message } from '@sockudo/ws';
import WSClient from 'ws';

const server = new WebSocketServer({ port: 9100, host: '127.0.0.1' });

await server.start((ws, info) => {
  console.log('[server] onConnection fired. ws:', typeof ws, 'info:', info);
  if (!ws) {
    console.error('[server] ws is null/undefined!');
    return;
  }
  console.log('[server] ws keys:', Object.keys(ws));
  ws.onMessage((msg) => {
    console.log('[server] got msg, isText:', msg.isText);
    ws.send(Message.text('echo: ' + (msg.isText ? msg.asText() : '<binary>')));
  });
  ws.send(Message.text('hello from server'));
});
console.log('[server] started');

await new Promise((r) => setTimeout(r, 500));

const client = new WSClient('ws://127.0.0.1:9100');
client.on('open', () => {
  console.log('[client] open');
  client.send('ping');
});
client.on('message', (data) => {
  console.log('[client] got:', data.toString());
  client.close();
});
client.on('close', () => {
  console.log('[client] closed, exiting');
  setTimeout(() => process.exit(0), 200);
});
