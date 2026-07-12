# @kuralle-agents/trace-ui

Dependency-free, read-only Kuralle trace viewer for embedding in any browser app.

```ts
import { mountTraceViewer } from '@kuralle-agents/trace-ui';

const viewer = mountTraceViewer(document.querySelector('#traces')!, {
  sessionId: 'session-42',
  loadTraces: (sessionId) => fetch(`/api/traces/${sessionId}`).then((response) => response.json()),
  nonce: window.__CSP_NONCE__,
});
await viewer.refresh();
```

The viewer uses Shadow DOM when available, bundles all styles, makes no writes,
and loads the same JSON `AgentTrace[]` returned by `Runtime.listTraces()`.
