import { mountTraceViewer } from '@kuralle-agents/trace-ui';

const viewer = mountTraceViewer(document.querySelector('#traces')!, {
  sessionId: 'session-42',
  loadTraces: (sessionId) => fetch(`/api/traces/${sessionId}`).then((response) => response.json()),
  nonce: (window as unknown as { __CSP_NONCE__: string }).__CSP_NONCE__,
});
await viewer.refresh();
