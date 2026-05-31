# HTTP Support Example

Runs a customer support voice agent over HTTP + SSE.

## Run

```bash
bun run --cwd apps/playground/transport-examples http-support
```

## Endpoint

- SSE session stream: `GET /session?id=<session-id>`
- Input messages: `POST /session?id=<session-id>`
