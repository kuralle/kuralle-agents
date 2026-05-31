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

## Wire into Runtime hooks

The canonical pattern — hooks automatically track the full agent lifecycle:

```ts
import { Runtime, type HarnessHooks } from '@kuralle-agents/core';

let currentAgentId = 'default';
const conversationId = `conv-${Date.now()}`;

const hooks: HarnessHooks = {
  async onAgentStart(context, agentId) {
    currentAgentId = agentId;
    await analytics.track({
      sessionId: context.session.id, conversationId, agentId, workspaceId: 'my-workspace',
      type: 'conversation.started',
      data: { startTime: new Date().toISOString() },
    });
  },
  async onToolCall(context, call) {
    await analytics.track({
      sessionId: context.session.id, conversationId, agentId: currentAgentId, workspaceId: 'my-workspace',
      type: 'tool.called',
      data: { toolName: call.toolName, toolCallId: call.toolCallId },
    });
  },
  async onToolResult(context, call) {
    await analytics.track({
      sessionId: context.session.id, conversationId, agentId: currentAgentId, workspaceId: 'my-workspace',
      type: 'tool.completed',
      data: { toolName: call.toolName, success: call.success, durationMs: call.durationMs },
    });
  },
  async onHandoff(context, from, to, reason) {
    await analytics.track({
      sessionId: context.session.id, conversationId, agentId: from, workspaceId: 'my-workspace',
      type: 'handoff.initiated',
      data: { from, to, reason },
    });
    currentAgentId = to;
  },
  async onEnd(context, result) {
    await analytics.track({
      sessionId: context.session.id, conversationId, agentId: currentAgentId, workspaceId: 'my-workspace',
      type: 'conversation.ended',
      data: { success: result.success, stepCount: context.stepCount },
    });
    await analytics.flush();
  },
};

const runtime = new Runtime({ agents, defaultAgentId: 'support', hooks });
```

## Event types

| Type | When |
|------|------|
| `conversation.started` | `onAgentStart` on first turn |
| `tool.called` | `onToolCall` |
| `tool.completed` | `onToolResult` |
| `handoff.initiated` | `onHandoff` |
| `conversation.ended` | `onEnd` |
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
