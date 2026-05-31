# WebSocket Audio Stream Example

Runs a JSON-based WebSocket protocol for text/audio turn exchange.

## Run

```bash
bun run --cwd apps/playground/transport-examples websocket-audio-stream
```

## Optional test client

```bash
bun run --cwd apps/playground/transport-examples test-client
```

## Endpoint

- WebSocket server: `ws://localhost:8080/ws/<session-id>`
