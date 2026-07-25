# Analytics SDK

Package: `@kuralle-agents/analytics-sdk`

Track conversations, tool calls, handoffs, and voice calls with structured events.

## Install and create client

```bash
bun add @kuralle-agents/analytics-sdk
```

```ts
import { createAnalyticsClient } from '@kuralle-agents/analytics-sdk';

const analytics = createAnalyticsClient({
  apiKey: process.env.ANALYTICS_API_KEY!,
  workspaceId: 'my-workspace',
});

// Set shared context to avoid repeating fields on every call
analytics.setContext({ workspaceId: 'my-workspace', agentId: 'support', sessionId: 'session-123' });
```

## Wire into runtime tracing

`TraceSink.write(span)` receives every completed turn, flow, node, tool, handoff, and model span without changing agent code. Turn spans keep the initiating `agentId`; spans opened after a handoff carry the new active agent.

```ts
import {
  createRuntime,
  OtelTraceSink,
  type AgentSpan,
  type TraceSink,
} from '@kuralle-agents/core';
import {
  createAnalyticsClient,
  type AnalyticsClient,
  type AnalyticsEventType,
} from '@kuralle-agents/analytics-sdk';

const analytics = createAnalyticsClient({
  apiKey: process.env.ANALYTICS_API_KEY!,
  workspaceId: 'my-workspace',
});

class AnalyticsTraceSink implements TraceSink {
  constructor(
    private readonly client: AnalyticsClient,
    private readonly workspaceId: string,
  ) {}

  async write(span: AgentSpan): Promise<void> {
    const { sessionId, agentId = 'unknown' } = span.attributes;
    await this.client.track({
      sessionId,
      conversationId: sessionId,
      agentId,
      workspaceId: this.workspaceId,
      type: analyticsEventType(span),
      data: {
        traceId: span.traceId,
        spanId: span.spanId,
        parentSpanId: span.parentSpanId,
        kind: span.kind,
        name: span.name,
        status: span.status,
        startTime: new Date(span.startTime).toISOString(),
        endTime: span.endTime ? new Date(span.endTime).toISOString() : undefined,
        durationMs: span.endTime ? span.endTime - span.startTime : undefined,
        attributes: span.attributes,
      },
    });
  }

  flush(): Promise<void> {
    return this.client.flush();
  }
}

function analyticsEventType(span: AgentSpan): AnalyticsEventType {
  if (span.kind === 'turn') return 'conversation.ended';
  if (span.kind === 'tool') return span.status === 'error' ? 'tool.error' : 'tool.completed';
  if (span.kind === 'handoff') return 'handoff.initiated';
  if (span.kind === 'node') return 'node.exited';
  return 'custom';
}

const runtime = createRuntime({
  agents,
  defaultAgentId: 'support',
  tracing: {
    sinks: [
      new AnalyticsTraceSink(analytics, 'my-workspace'),
      new OtelTraceSink({
        endpoint: process.env.OTEL_EXPORTER_OTLP_ENDPOINT!,
        serviceName: 'support-agent',
      }),
    ],
  },
});
```

The runtime also keeps spans in its configured `TraceStore` (an in-memory store by default), so the same run is available through `runtime.getTrace()` and `runtime.listTraces()` as well as pushed to each sink. Use `OtelTraceSink` directly when the analytics backend accepts OTLP; `langfuseSink()` is the preconfigured Langfuse variant.

## Event types

| Type | When |
|------|------|
| `conversation.ended` | Completed `turn` span |
| `tool.completed` | Successful `tool` span |
| `tool.error` | Failed `tool` span |
| `handoff.initiated` | `handoff` span |
| `node.exited` | Completed `node` span |
| `custom` | Any time via `analytics.track({ type: 'custom', ... })` |

## Voice call tracking

Voice calls have richer metrics — use dedicated methods:

```ts
// Start
await analytics.trackVoiceCall({
  sessionId: 'call-123', workspaceId: 'my-workspace', agentId: 'voice-agent',
  startedAt: new Date(),
});

// Update during call
await analytics.updateVoiceCall('call-123', {
  interruptions: 2, userTurns: 5, agentTurns: 4, currentNode: 'booking_flow',
});

// End
await analytics.updateVoiceCall('call-123', {
  endedAt: new Date(), durationSeconds: 180,
  outcome: 'booking_completed', ttfMs: 850,
});
```

## React integration

```tsx
import { AnalyticsProvider, useAnalytics, usePageView, useVoiceCallTracker } from '@kuralle-agents/analytics-sdk/react';

// Wrap app
<AnalyticsProvider config={{ apiKey, workspaceId }}>
  <App />
</AnalyticsProvider>

// Track events
const { track } = useAnalytics();
track({ type: 'custom', sessionId, agentId, workspaceId, data: { action: 'chat_opened' } });

// Track page views
usePageView('dashboard', { section: 'analytics' });

// Track voice calls
const { startCall, endCall, trackInterruption } = useVoiceCallTracker(sessionId, workspaceId);
```

## Always flush before exit

The SDK batches events and flushes on a 5-second timer. Flush manually before process exit:

```ts
process.on('SIGTERM', async () => {
  await analytics.flush();
  process.exit(0);
});
```
