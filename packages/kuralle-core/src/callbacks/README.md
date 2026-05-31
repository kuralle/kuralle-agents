# Callbacks Module

This module provides utilities for integrating Kuralle with external systems via HTTP callbacks.

## Stream Callback Adapter (Recommended)

Use `createStreamCallbackAdapter` for non-blocking event delivery with pluggable sinks:

- sinks are optional (if omitted, adapter becomes a no-op)
- built-in sinks: console, file
- custom sinks: function handler (HTTP, DB, queue, etc.)
- bounded queue with drop policy to protect latency
- default event mode is message-oriented (input + done/error/tripwire + tool + transition events)
- default text behavior emits final text only (no token deltas)

```typescript
import {
  Runtime,
  createStreamCallbackAdapter,
  createFileStreamSink,
  createHttpStreamSink,
  createFunctionStreamSink,
} from '@kuralle-agents/core';

const adapter = createStreamCallbackAdapter({
  sinks: [
    createFileStreamSink({ directory: './logs/transcripts' }), // auto file per run/session
    createHttpStreamSink({ url: 'https://example.com/webhook' }),
    createFunctionStreamSink(async payload => {
      // Send to DB/queue/endpoint of your choice
      await myWriter.write(payload);
    }, 'custom-writer'),
  ],
  includeFullText: true,
  maxQueueSize: 5000,
  dropPolicy: 'drop_oldest',
  eventMode: 'message', // default
  emitTextDeltas: false, // default
  emitToolEvents: true, // default
  emitTransitionEvents: true, // default
  emitFinalText: true, // default
});

const runtime = new Runtime({
  agents: [agent],
  defaultAgentId: 'chat',
  streamCallback: {
    sinks: [createFileStreamSink({ directory: './logs/transcripts' })],
    includeFullText: false, // final text still included on done/error by default
    flushOnEnd: false,
  },
});
```

### Recommended Defaults for External Persistence

For DB / queue / webhook pipelines (thread-session-message storage), use message-level events:

```ts
streamCallback: {
  sinks: [createFunctionStreamSink(async payload => writeToDb(payload))],
  eventMode: 'message',      // input + done/error/tripwire + tool + transition events
  emitTextDeltas: false,     // avoid token-level write amplification
  emitToolEvents: true,      // include tool-call/result/error for transparency
  emitTransitionEvents: true, // include flow-transition/handoff
  emitFinalText: true,       // capture final assistant message text
  flushOnEnd: false,         // keep hot path non-blocking
}
```

To disable tool events for minimal payloads:

```ts
streamCallback: {
  sinks: [createFileStreamSink({ directory: './logs/transcripts' })],
  eventMode: 'message',
  emitToolEvents: false,
  emitTransitionEvents: false,
}
```

To opt back into high-volume token streaming:

```ts
streamCallback: {
  sinks: [createConsoleStreamSink()],
  eventMode: 'all',
  emitTextDeltas: true,
}
```

## HTTP Callback

The `createHttpCallback` function creates a hook that sends stream events to an HTTP endpoint (webhook) in a fire-and-forget manner.

### Features

- **Environment Variable Support**: Headers and URLs support `$ENV.VAR_NAME` and `${ENV.VAR_NAME}` syntax
- **Event Filtering**: `allowList` and `denyList` to control which events are sent
- **Full Text Accumulation**: Optional `includeFullText` to accumulate text-delta events into complete responses
- **Non-blocking**: Uses fire-and-forget pattern to avoid impacting stream performance

### Basic Usage

```typescript
import { Runtime, createHttpCallback, type AgentConfig } from '@kuralle-agents/core';

const callbackConfig = {
  url: 'https://your-webhook.com/events',
  method: 'POST',
  headers: {
    'Authorization': 'Bearer $ENV.API_KEY',
    'X-Source': 'kuralle',
  },
  allowList: ['text-delta', 'tool-call', 'error'],
  includeFullText: true,
};

const runtime = new Runtime({
  agents: [agent],
  defaultAgentId: 'chat',
  callback: callbackConfig,
});
```

### Configuration Options

| Option | Type | Default | Description |
|---------|---------|-----------|-------------|
| `url` | `string` (required) | - | Webhook endpoint URL |
| `method` | `'POST' \| 'PUT'` | `'POST'` | HTTP method to use |
| `headers` | `Record<string, string>` | - | Custom headers for the request |
| `allowList` | `string[]` | `[]` (all events) | Event types to send (whitelist) |
| `denyList` | `string[]` | `[]` (none) | Event types to block (blacklist) |
| `includeFullText` | `boolean` | `false` | Include accumulated full text in payload |

### Event Types

All `HarnessStreamPart` types are available for filtering:

- `text-delta` - Text tokens as they stream
- `tool-call` - Tool invocation starts
- `tool-result` - Tool returns data
- `tool-error` - Tool fails
- `tool-start` - Tool begins (with filler)
- `tool-done` - Tool completes (with duration)
- `handoff` - Agent handoff occurs
- `agent-start` / `agent-end` - Agent lifecycle
- `step-start` / `step-end` - Step lifecycle
- `node-enter` / `node-exit` - Flow node transitions
- `flow-transition` / `flow-end` - Flow lifecycle
- `error` - Errors occur
- `done` - Session completes

### Payload Format

Each callback sends a JSON payload:

```json
{
  "sessionId": "uuid",
  "agentId": "agent-id",
  "timestamp": "2026-02-01T16:40:36.950Z",
  "part": {
    "type": "text-delta",
    "text": "Hello"
  },
  "fullText": "Hello! I'm here to help."
}
```

- `sessionId` - Current session identifier
- `agentId` - Active agent ID
- `timestamp` - ISO 8601 timestamp
- `part` - Original stream event
- `fullText` - (optional) Accumulated text when `includeFullText` is true

### Environment Variable Resolution

Headers and URLs support both `$ENV.VAR_NAME` and `${ENV.VAR_NAME}` syntax:

```typescript
const config = {
  url: 'https://$ENV.API_HOST.com/webhook',
  headers: {
    'Authorization': 'Bearer $ENV.API_KEY',
    'X-Custom': '${ENV.CUSTOM_VALUE}',
  },
};
```

Environment variables must be set in `process.env`:

```bash
export API_KEY="sk-..."
export API_HOST="api.example.com"
```

### Filtering Logic

1. **DenyList** takes precedence over allowList
2. If an event type is in `denyList`, it's never sent
3. If `allowList` is non-empty, only those event types are sent
4. If `allowList` is empty, all non-denied events are sent

Example:

```typescript
{
  allowList: ['text-delta', 'tool-call'],  // Only send these
  denyList: ['step-start', 'step-end'],  // But never these
}
```

### Full Text Accumulation

When `includeFullText: true`, the callback accumulates `text-delta` events:

- First `text-delta`: `fullText = "H"`
- Second `text-delta`: `fullText = "He"`
- Third `text-delta`: `fullText = "Hel"`

The accumulator is cleared at `turn-end`, `error`, or `done` events.

### Performance Considerations

- **Non-blocking**: HTTP requests fire without awaiting response
- **Error handling**: Failed requests log to console but don't block stream
- **Rate limiting**: Consider implementing rate limiting at webhook endpoint
- **Batching**: For high-volume events, consider batching at the receiving end

### Examples

See `packages/kuralle-core/examples/http-webhook-demo.ts` for a complete working example including:
- Mock webhook server
- Event filtering with allowList/denyList
- Environment variable substitution
- Full text accumulation
- Tool events (tool-call, tool-result)

### Security Best Practices

1. **Never commit API keys**: Use environment variables only
2. **Validate webhooks**: Verify webhook signature at receiving end
3. **Use HTTPS**: Always use secure endpoints in production
4. **Sanitize headers**: Avoid leaking sensitive data through headers
5. **Implement timeout**: Configure webhook server with reasonable timeouts

### Important: Internal Event Exposure

`HarnessStreamPart` includes internal orchestration events such as:
- `tool-call` / `tool-result` / `tool-error`
- `handoff`
- `node-enter` / `flow-transition`

These events can contain sensitive arguments, internal routing decisions, or operational metadata.

Recommendations:
- Treat webhook endpoints as privileged internal consumers.
- For user-facing analytics/log shipping, prefer an `allowList` limited to `text-delta`, `error`, `done` (and optionally `turn-end`).
- Avoid forwarding raw tool arguments/results unless you have a clear privacy/security story.
