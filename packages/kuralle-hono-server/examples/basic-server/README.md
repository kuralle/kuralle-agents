# Basic Hono Server Example

## Run

```bash
npm install
npm run dev
```

## Test

```bash
curl -s http://localhost:3333/health

curl -s http://localhost:3333/api/chat \
  -H 'Content-Type: application/json' \
  -d '{"message":"Hello!"}'

curl -N http://localhost:3333/api/chat/sse \
  -H 'Content-Type: application/json' \
  -d '{"message":"Give me a one-sentence summary of your support hours."}'
```
