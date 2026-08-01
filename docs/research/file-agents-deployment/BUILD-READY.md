# Build-ready gate

## Green-light decision

Build the canonical revision and pinned-thread vertical slice before folder codegen or deployment
templates. It is the shared seam both user goals require; codegen without it would cement a second,
incompatible deployment model.

## First three commits

1. `fix: persist production conversation audit events`
   - persist turn deltas into dedicated audit stores;
   - merge dedicated and inline crash-safe copies on replay;
   - preserve metadata in the Cloudflare bridge;
   - discriminative Core and CF tests.
2. `feat: add canonical agent revisions and release store`
   - new workerd-safe `@kuralle-agents/deployment` package;
   - strict artifact schema, canonical hashing, immutable in-memory store;
   - entity/version/branch/release/thread-pin ports;
   - artifact parity, immutability, release assignment and pinning tests.
3. `feat: bind revisions to executable runtimes`
   - capability/model/secret registries;
   - revision compatibility preflight;
   - runtime factory and trace attributes;
   - one folder fixture and one DB fixture resolve to the same artifact and behavior.

## Implementation sequence

| Slice | Exit evidence |
|---|---|
| 0. Repair baseline | Core/CF audit tests, package typechecks, root baseline gaps recorded |
| 1. Revision IR | strict schema rejects unknowns/secrets/paths; canonical digest stable on Node and workerd |
| 2. Control-plane ports | immutable version writes, active pointer, weighted releases, deterministic assignment |
| 3. Thread pins | atomic create-and-pin; v1 thread remains v1 after v2 publish; cross-tenant access rejected |
| 4. Binder | registry/HTTP/MCP refs bind; missing/incompatible capability fails preflight |
| 5. Folder compiler | deterministic discovery/codegen/source map; symlink/collision/cycle/quota diagnostics |
| 6. Database adapter | drafts publish the identical IR; visibility/ownership enforced |
| 7. Node host | Hono start, Postgres lease/outbox/audit, bare and Docker smoke |
| 8. Cloudflare host | generic thread DO, SQLite pin/state, R2 blobs, Queue export, workerd tests |
| 9. Operations | rollout/rollback, migrations, readiness/drain, OTLP/audit docs and examples |

## Decisive integration test

For both Node/Postgres and Cloudflare/DO SQLite:

1. publish v1 and start thread A;
2. publish/activate v2;
3. prove thread A still uses v1 and new thread B uses v2;
4. restart the Node process or evict the DO;
5. prove both pins, messages, checkpoints, audit events and trace attributes survive;
6. attempt cross-tenant access to both thread IDs and prove denial before store access;
7. invoke an idempotent side-effecting tool twice with the same delivery key and prove one effect;
8. rollback new-thread traffic to v1 without altering thread B;
9. verify exact artifact/prompt/skill hashes appear in traces and audit.

## Commands expected at completion

```bash
bun test packages/deployment/test
bun test packages/build/test
bun test packages/core/test/review/flows-audit-adversarial.test.ts
bun test packages/cf-agent/src/__tests__/BridgeSessionStore.test.ts
bun run build
bun run typecheck:all
docker build -f packages/deployment/templates/node/Dockerfile .
wrangler deploy --dry-run --config <generated-wrangler-config>
```

The existing root baseline has two unrelated failures that must not be mistaken for new regressions:
the workerd Vitest setup cannot resolve `vitest/worker`, and a workspace test constructs an outdated
`Session` without `conversationId`/`channelId`. Repair both during slice 0.

