# @kuralle-agents/analytics-sdk

Type-safe client for sending Kuralle agent analytics events to the Kuralle Analytics Platform.

## Install

```bash
npm install @kuralle-agents/analytics-sdk
```

## What it does

Batches and ships typed analytics events — conversation starts, tool calls, flow node transitions, voice call metrics — from Kuralle agents to the analytics backend.

- **`createAnalyticsClient`** — factory; returns an `KuralleAnalytics` instance wired to an `HttpSink` and `Batcher`.
- **`KuralleAnalytics`** — the client class. Methods: `track(event)`, `trackBatch(events)`, `trackVoiceCall(data)`, `updateVoiceCall(sessionId, data)`, `flush()`, `setContext(context)`, `identify(userId, traits?)`, `destroy()`.
- **`Batcher`** — collects events and flushes in configurable batches (default: 20 events or 5 s).
- **`HttpSink`** — HTTP transport to the analytics endpoint with exponential-backoff retry.
- **`AnalyticsEventSchema`** / **`validateAnalyticsEvent`** — Zod schema and validator for event payloads.
- React subpath (`@kuralle-agents/analytics-sdk/react`) — `useAnalytics`, `AnalyticsProvider`, `usePageView`, `useVoiceCallTracker`, `useTrackEvent`.

## Usage

```typescript
import { createAnalyticsClient } from '@kuralle-agents/analytics-sdk';

const analytics = createAnalyticsClient({
  apiKey: process.env.ANALYTICS_API_KEY!,
  workspaceId: 'workspace-456',
});

await analytics.track({
  sessionId: 'session-123',
  agentId: 'support',
  workspaceId: 'workspace-456',
  type: 'conversation.started',
  data: { channel: 'web' },
});

// Flush before shutdown
await analytics.flush();
```

### React

```tsx
import { AnalyticsProvider, useAnalytics } from '@kuralle-agents/analytics-sdk/react';

function App() {
  return (
    <AnalyticsProvider config={{ apiKey: process.env.ANALYTICS_API_KEY!, workspaceId: 'ws-456' }}>
      <YourApp />
    </AnalyticsProvider>
  );
}

function MyComponent() {
  const { track } = useAnalytics();
  return <button onClick={() => track({ type: 'custom', sessionId: 's', agentId: 'a', workspaceId: 'w', data: {} })}>Go</button>;
}
```

## Related

- [`@kuralle-agents/core`](../core) — runtime, agents, flows
