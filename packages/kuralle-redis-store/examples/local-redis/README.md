# Local Redis SessionStore Example

## Start Redis (local)

```bash
redis-server --port 6380 --save "" --appendonly no
```

## Run Example

```bash
cd packages/kuralle-redis-store
REDIS_URL=redis://127.0.0.1:6380 npm run dev:local
```

## Multi-turn Example + Dumped Session

```bash
cd packages/kuralle-redis-store
REDIS_URL=redis://127.0.0.1:6380 npm run dev:multi
```

Outputs:
- `examples/local-redis/logs/conversation.jsonl`
- `examples/local-redis/logs/session.json`
- `examples/local-redis/logs/session.raw.json`
