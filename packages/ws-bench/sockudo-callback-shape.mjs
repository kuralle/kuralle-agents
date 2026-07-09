// Definitive test of the @sockudo/ws callback signature shape.
import { WebSocketServer, Message } from '@sockudo/ws';
import WSClient from 'ws';

const server = new WebSocketServer({ port: 9201, host: '127.0.0.1' });

await server.start(function onConnection(...args) {
  console.log('args.length:', args.length);
  console.log('args[0]:', args[0] === null ? 'null' : typeof args[0]);
  console.log('args[0] keys:', args[0] && typeof args[0] === 'object' ? Object.keys(args[0]) : '(not object)');
  console.log('args[1]:', Array.isArray(args[1]) ? `Array(${args[1].length})` : typeof args[1]);
  if (Array.isArray(args[1])) {
    console.log('  args[1][0]:', typeof args[1][0], args[1][0] && Object.keys(args[1][0]));
    console.log('  args[1][1]:', JSON.stringify(args[1][1]));
  }
  // Now try BOTH shapes and see which has .send
  if (args[0] && typeof args[0].send === 'function') {
    console.log('=> args[0] has .send');
    args[0].send(Message.text('hi from args[0]'));
  } else if (Array.isArray(args[1]) && typeof args[1][0]?.send === 'function') {
    console.log('=> args[1][0] has .send');
    args[1][0].send(Message.text('hi from args[1][0]'));
  } else {
    console.log('=> NO .send found anywhere');
  }
});
console.log('[server] up');

await new Promise((r) => setTimeout(r, 300));
const c = new WSClient('ws://127.0.0.1:9201');
c.on('message', (d) => { console.log('[client] received:', d.toString()); c.close(); });
c.on('close', () => setTimeout(() => process.exit(0), 200));
