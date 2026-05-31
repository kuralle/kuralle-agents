/**
 * Test client for Text WebSocket Agent
 *
 * Usage:
 *   bun run test-client
 */

import WebSocket from 'ws';

const WS_URL = 'ws://localhost:8080/ws/test-session';

console.log('Connecting to', WS_URL);
console.log('');

const ws = new WebSocket(WS_URL);
let turnCount = 0;

ws.on('open', () => {
  console.log('Connected!');
  console.log('Sending message...');
  console.log('');
  ws.send(JSON.stringify({ type: 'user_text', text: 'Hello! What tools do you have available?' }));
});

ws.on('message', (data: Buffer) => {
  const part = JSON.parse(data.toString());

  switch (part.type) {
    case 'session_started':
      console.log(`Session: ${part.sessionId}`);
      break;

    case 'text-delta':
      process.stdout.write(part.text);
      break;

    case 'tool-call':
      console.log(`\n[TOOL] ${part.toolName}(${JSON.stringify(part.args)})`);
      break;

    case 'tool-result':
      console.log(`[RESULT] ${part.toolName}: ${JSON.stringify(part.result)}`);
      break;

    case 'done':
      console.log('\n');
      turnCount++;

      if (turnCount === 1) {
        // Send follow-up after first response
        setTimeout(() => {
          console.log('Sending follow-up...');
          ws.send(JSON.stringify({ type: 'user_text', text: 'Can you check the status of order ORD-12345?' }));
        }, 1000);
      } else {
        setTimeout(() => ws.close(), 1000);
      }
      break;

    case 'error':
      console.error(`[ERROR] ${part.error}`);
      break;

    default:
      // Other runtime events (step-start, agent-start, etc.) — log if interesting
      if (part.type === 'handoff') {
        console.log(`[HANDOFF] ${part.from} -> ${part.to}: ${part.reason}`);
      }
      break;
  }
});

ws.on('error', (error) => {
  console.error('WebSocket error:', error);
});

ws.on('close', () => {
  console.log('Connection closed');
  process.exit(0);
});

// Safety timeout
setTimeout(() => {
  console.log('\nTimeout — closing');
  ws.close();
}, 30000);
